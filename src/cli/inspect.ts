import { extractUrls } from '../bill/source.js';
import { assertAllowedUrl, BlockedUrlError } from '../browser/allowlist.js';
import { searchableText } from '../gmail/parse.js';
import { buildContext } from './context.js';

/* eslint-disable no-console */

/**
 * Read-only structural inspection of one message, for diagnosing why a bill
 * could not be obtained.
 *
 * Prints structure, not content: headers, MIME parts, attachments, and the
 * links it contains. URL query strings are redacted because they routinely
 * carry per-account tracking identifiers.
 */
export async function inspectCommand(messageId: string): Promise<number> {
  const context = buildContext();
  try {
    const { config, reader } = context;
    const message = await reader.getMessage(messageId);

    console.log(`\n  Message ${message.id}`);
    console.log(`    date:    ${message.internalDate.toISOString()}`);
    console.log(`    from:    ${message.from?.email ?? '(none)'}`);
    console.log(`    subject: ${message.subject}`);
    console.log(`    labels:  ${message.labelIds.join(', ')}`);

    console.log(`\n  Body`);
    console.log(`    text/plain: ${message.bodyText.length} chars`);
    console.log(`    text/html:  ${message.bodyHtml.length} chars`);
    console.log(`    scannable:  ${searchableText(message).length} chars`);

    console.log(`\n  Attachments (${message.attachments.length})`);
    if (message.attachments.length === 0) {
      console.log('    (none — the bill is not attached to this email)');
    }
    for (const attachment of message.attachments) {
      console.log(`    ${attachment.filename}  ${attachment.mimeType}  ${attachment.size} bytes`);
    }

    const urls = extractUrls(message);
    console.log(`\n  Links (${urls.length}) — query strings redacted`);
    let allowedCount = 0;
    const seen = new Set<string>();

    for (const raw of urls) {
      let display: string;
      let verdict: string;
      try {
        const url = assertAllowedUrl(raw, config.verizonAllowedDomains);
        allowedCount += 1;
        display = `${url.origin}${url.pathname}`;
        verdict = url.search ? 'ALLOWED (has query string)' : 'ALLOWED';
      } catch (error) {
        const parsed = (() => {
          try {
            return new URL(raw);
          } catch {
            return null;
          }
        })();
        display = parsed ? `${parsed.origin}${parsed.pathname}` : raw.slice(0, 80);
        verdict = error instanceof BlockedUrlError ? 'blocked' : 'unparseable';
      }

      const key = `${verdict}|${display}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`    [${verdict}] ${display}`);
    }

    console.log(`\n  ${allowedCount} link(s) on an allowlisted host.`);
    console.log('  Nothing was fetched, downloaded, or sent.\n');
    return 0;
  } finally {
    context.close();
  }
}
