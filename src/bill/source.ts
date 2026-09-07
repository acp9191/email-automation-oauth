import type { NormalizedMessage } from '../gmail/types.js';
import type { GmailReader } from '../gmail/types.js';
import { assertAllowedUrl, BlockedUrlError } from '../browser/allowlist.js';
import { sha256, verifyPdf, MAX_PDF_BYTES } from './pdf.js';
import { childLogger } from '../logging/index.js';

/**
 * Where a bill PDF can come from, cheapest and safest first:
 *
 *   1. a PDF attached to the notification email      (no network, no auth)
 *   2. a direct download link on an allowlisted host (one guarded fetch)
 *   3. the Verizon portal via a real browser         (needs a human session)
 *
 * Each source either returns a verified PDF, reports that it has nothing, or
 * asks for manual intervention. None of them guess.
 */

export type BillOrigin = 'gmail-attachment' | 'bill-link' | 'browser';

export interface BillArtifact {
  content: Buffer;
  sha256: string;
  byteLength: number;
  origin: BillOrigin;
  /** Human-readable description of where this came from, safe to log. */
  originDetail: string;
  /** The sender-supplied name, if any. NOT used as the stored filename. */
  suggestedName: string | null;
}

export type BillAcquisition =
  | { status: 'acquired'; artifact: BillArtifact }
  | { status: 'unavailable'; reason: string }
  | { status: 'needs_intervention'; reason: string; instructions: string };

export interface BillSourceContext {
  message: NormalizedMessage;
  reader: GmailReader;
  allowedDomains: string[];
  dryRun: boolean;
}

export interface BillSource {
  readonly id: BillOrigin;
  readonly description: string;
  acquire(context: BillSourceContext): Promise<BillAcquisition>;
}

/** 1. A PDF attached directly to the notification. */
export class AttachmentBillSource implements BillSource {
  readonly id = 'gmail-attachment' as const;
  readonly description = 'PDF attached to the Gmail notification';
  private readonly log = childLogger({ component: 'bill.attachment' });

  async acquire({ message, reader }: BillSourceContext): Promise<BillAcquisition> {
    const candidates = message.attachments.filter(
      (attachment) =>
        attachment.attachmentId !== null &&
        attachment.size > 0 &&
        attachment.size <= MAX_PDF_BYTES &&
        (attachment.mimeType.toLowerCase().includes('pdf') || /\.pdf$/i.test(attachment.filename)),
    );

    if (candidates.length === 0) {
      return { status: 'unavailable', reason: 'no PDF attachment on the message' };
    }

    const failures: string[] = [];
    for (const candidate of candidates) {
      const content = await reader.getAttachment(message.id, candidate.attachmentId!);
      const check = verifyPdf(content);
      if (!check.valid) {
        // A file named .pdf that is not a PDF is exactly what we refuse to forward.
        failures.push(`${candidate.filename}: ${check.reason}`);
        this.log.warn({ filename: candidate.filename, reason: check.reason }, 'attachment failed PDF verification');
        continue;
      }
      return {
        status: 'acquired',
        artifact: {
          content,
          sha256: check.sha256,
          byteLength: check.byteLength,
          origin: this.id,
          originDetail: `Gmail attachment on message ${message.id}`,
          suggestedName: candidate.filename,
        },
      };
    }

    return { status: 'unavailable', reason: `attachment(s) present but not valid PDFs — ${failures.join('; ')}` };
  }
}

const MAX_REDIRECTS = 3;
const MAX_LINKS_TRIED = 3;

/**
 * Pulls http(s) URLs out of an email body. All of them are untrusted.
 *
 * The RAW html is scanned, not the flattened text: tag-stripping destroys
 * `href` attributes, which is where every link in an HTML email actually lives.
 * The pattern stops at quotes and angle brackets, so attribute values come out
 * cleanly without needing a parser.
 */
export function extractUrls(message: NormalizedMessage): string[] {
  const haystack = `${message.bodyText}\n${message.bodyHtml}`.slice(0, 500_000);
  const found = haystack.match(/https?:\/\/[^\s"'<>)\]]+/gi) ?? [];
  const cleaned = found.map((url) => url.replace(/[.,;:]+$/, '').replace(/&amp;/gi, '&'));
  return [...new Set(cleaned)];
}

function looksLikeBillLink(url: URL): boolean {
  const haystack = `${url.pathname}${url.search}`.toLowerCase();
  return ['bill', 'statement', 'invoice', 'pdf'].some((token) => haystack.includes(token));
}

/**
 * 2. A direct download link.
 *
 * Every hop — including redirects — is re-checked against the allowlist, the
 * response is size-capped, and the bytes must verify as a real PDF. In practice
 * Verizon links land on a login page, which fails verification and falls
 * through to the browser source; that is the intended behaviour, not a bug.
 */
export class DirectLinkBillSource implements BillSource {
  readonly id = 'bill-link' as const;
  readonly description = 'direct PDF link on an allowlisted Verizon host';
  private readonly log = childLogger({ component: 'bill.link' });

  async acquire({ message, allowedDomains }: BillSourceContext): Promise<BillAcquisition> {
    const candidates: URL[] = [];
    for (const raw of extractUrls(message)) {
      try {
        const url = assertAllowedUrl(raw, allowedDomains);
        if (looksLikeBillLink(url)) candidates.push(url);
      } catch (error) {
        if (error instanceof BlockedUrlError) {
          this.log.debug({ reason: error.message }, 'link rejected by allowlist');
        }
      }
    }

    if (candidates.length === 0) {
      return { status: 'unavailable', reason: 'no allowlisted bill-looking links in the message' };
    }

    const failures: string[] = [];
    for (const candidate of candidates.slice(0, MAX_LINKS_TRIED)) {
      try {
        const content = await this.fetchPdf(candidate, allowedDomains);
        const check = verifyPdf(content);
        if (!check.valid) {
          failures.push(`${candidate.hostname}${candidate.pathname}: ${check.reason}`);
          continue;
        }
        return {
          status: 'acquired',
          artifact: {
            content,
            sha256: check.sha256,
            byteLength: check.byteLength,
            origin: this.id,
            originDetail: `${candidate.origin}${candidate.pathname}`,
            suggestedName: null,
          },
        };
      } catch (error) {
        failures.push(`${candidate.hostname}: ${(error as Error).message}`);
      }
    }

    return { status: 'unavailable', reason: `no link yielded a valid PDF — ${failures.join('; ')}` };
  }

  private async fetchPdf(start: URL, allowedDomains: string[]): Promise<Buffer> {
    let current = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await fetch(current, {
        redirect: 'manual',
        headers: { accept: 'application/pdf' },
        signal: AbortSignal.timeout(30_000),
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new Error(`redirect with no location (${response.status})`);
        // Re-validate every hop — a redirect is just another untrusted URL.
        current = assertAllowedUrl(new URL(location, current).toString(), allowedDomains);
        continue;
      }

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const declaredLength = Number(response.headers.get('content-length') ?? '0');
      if (declaredLength > MAX_PDF_BYTES) throw new Error(`content-length ${declaredLength} exceeds cap`);

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > MAX_PDF_BYTES) throw new Error('response exceeded size cap');
      return buffer;
    }
    throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
  }
}

/** Tries each source in order and returns the first verified PDF. */
export async function acquireBill(
  sources: BillSource[],
  context: BillSourceContext,
): Promise<BillAcquisition> {
  const reasons: string[] = [];
  let intervention: BillAcquisition | null = null;

  for (const source of sources) {
    const result = await source.acquire(context);
    if (result.status === 'acquired') return result;
    if (result.status === 'needs_intervention') {
      // Sources are ordered by preference, so the FIRST source to ask for help
      // has the most actionable instructions. Later, more generic fallbacks
      // must not overwrite it.
      intervention ??= result;
      reasons.push(`${source.id}: ${result.reason}`);
      continue;
    }
    reasons.push(`${source.id}: ${result.reason}`);
  }

  if (intervention) return intervention;
  return { status: 'unavailable', reason: reasons.join(' | ') || 'no bill sources configured' };
}

export { sha256 };
