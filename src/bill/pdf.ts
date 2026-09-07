import crypto from 'node:crypto';

/**
 * PDF verification.
 *
 * Attachments and downloads are untrusted bytes. We confirm the artifact really
 * is a PDF before it is stored or forwarded — we do not trust the sender's
 * declared MIME type or file extension, and we never parse or execute the file.
 */

export const MIN_PDF_BYTES = 512;
export const MAX_PDF_BYTES = 25 * 1024 * 1024;

export interface PdfCheck {
  valid: boolean;
  reason: string | null;
  sha256: string;
  byteLength: number;
}

export function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function verifyPdf(buffer: Buffer): PdfCheck {
  const result = { sha256: sha256(buffer), byteLength: buffer.byteLength };

  if (buffer.byteLength < MIN_PDF_BYTES) {
    return { ...result, valid: false, reason: `too small (${buffer.byteLength} bytes)` };
  }
  if (buffer.byteLength > MAX_PDF_BYTES) {
    return { ...result, valid: false, reason: `too large (${buffer.byteLength} bytes)` };
  }
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return { ...result, valid: false, reason: 'missing %PDF- header' };
  }
  // The trailer lives at the end; a truncated download will not have it.
  if (!buffer.subarray(-2048).toString('latin1').includes('%%EOF')) {
    return { ...result, valid: false, reason: 'missing %%EOF trailer (truncated?)' };
  }

  return { ...result, valid: true, reason: null };
}

/**
 * Produces a filename we control end to end.
 *
 * Sender-supplied names are never used directly: path separators, `..`,
 * control characters and anything else outside a strict allowlist are stripped.
 */
export function safePdfFilename(base: string): string {
  const cleaned = base
    // Allowlist, not denylist: anything outside this set (control characters,
    // path separators, unicode look-alikes) collapses to an underscore.
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, 120);
  const stem = cleaned.replace(/\.pdf$/i, '') || 'bill';
  return `${stem}.pdf`;
}
