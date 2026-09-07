import { describe, expect, it } from 'vitest';
import { safePdfFilename, verifyPdf } from '../src/bill/pdf.js';
import { makePdf } from './helpers/factories.js';

describe('PDF verification', () => {
  it('accepts a well-formed PDF', () => {
    expect(verifyPdf(makePdf())).toMatchObject({ valid: true, reason: null });
  });

  it('rejects an HTML login page masquerading as a PDF', () => {
    const html = Buffer.from(`<!doctype html><html><body>${'Sign in '.repeat(200)}</body></html>`);
    expect(verifyPdf(html)).toMatchObject({ valid: false, reason: 'missing %PDF- header' });
  });

  it('rejects a truncated download', () => {
    const truncated = makePdf().subarray(0, 600);
    expect(verifyPdf(truncated)).toMatchObject({ valid: false });
    expect(verifyPdf(truncated).reason).toMatch(/%%EOF/);
  });

  it('rejects an implausibly small file', () => {
    expect(verifyPdf(Buffer.from('%PDF-1.4'))).toMatchObject({ valid: false });
  });

  it('rejects a file over the size cap', () => {
    const huge = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(26 * 1024 * 1024), Buffer.from('%%EOF')]);
    expect(verifyPdf(huge).reason).toMatch(/too large/);
  });

  it('reports a stable sha256 for the same bytes', () => {
    expect(verifyPdf(makePdf()).sha256).toBe(verifyPdf(makePdf()).sha256);
  });
});

describe('filename sanitisation', () => {
  it('strips path traversal from a sender-supplied name', () => {
    const result = safePdfFilename('../../../../etc/passwd');
    expect(result).not.toContain('..');
    expect(result).not.toContain('/');
    expect(result).toBe('etc_passwd.pdf');
  });

  it('neutralises a windows path and a double extension', () => {
    expect(safePdfFilename('..\\..\\bill.pdf.exe')).toBe('bill.pdf.exe.pdf');
  });

  it('always ends in .pdf and never doubles it', () => {
    expect(safePdfFilename('Verizon_Internet_August_2026.pdf')).toBe('Verizon_Internet_August_2026.pdf');
    expect(safePdfFilename('Verizon_Internet_August_2026')).toBe('Verizon_Internet_August_2026.pdf');
  });

  it('falls back to a safe name when nothing usable survives', () => {
    expect(safePdfFilename('///')).toBe('bill.pdf');
  });

  it('caps the length', () => {
    expect(safePdfFilename('a'.repeat(500)).length).toBeLessThanOrEqual(124);
  });
});
