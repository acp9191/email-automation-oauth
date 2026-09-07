import { describe, expect, it } from 'vitest';
import { assertAllowedUrl, isAllowedUrl, isPrivateHost } from '../src/browser/allowlist.js';

const ALLOWED = ['verizon.com', 'secure.verizon.com'];

describe('URL allowlist', () => {
  it('allows an https URL on an allowlisted host', () => {
    expect(isAllowedUrl('https://secure.verizon.com/bill/123.pdf', ALLOWED)).toBe(true);
  });

  it('allows a subdomain of an allowlisted domain', () => {
    expect(isAllowedUrl('https://mybilling.verizon.com/statement.pdf', ALLOWED)).toBe(true);
  });

  it('blocks a host outside the allowlist', () => {
    expect(isAllowedUrl('https://attacker.example/bill.pdf', ALLOWED)).toBe(false);
  });

  it('blocks a look-alike domain that only ends with the brand name', () => {
    expect(isAllowedUrl('https://verizon.com.attacker.example/bill.pdf', ALLOWED)).toBe(false);
  });

  it('blocks plain http', () => {
    expect(isAllowedUrl('http://secure.verizon.com/bill.pdf', ALLOWED)).toBe(false);
  });

  it('blocks non-web schemes', () => {
    expect(isAllowedUrl('file:///etc/passwd', ALLOWED)).toBe(false);
    expect(isAllowedUrl('javascript:alert(1)', ALLOWED)).toBe(false);
  });

  it('blocks credentials embedded in the URL', () => {
    expect(isAllowedUrl('https://user:pass@secure.verizon.com/bill.pdf', ALLOWED)).toBe(false);
  });

  it('explains why it refused', () => {
    expect(() => assertAllowedUrl('https://evil.example/x', ALLOWED)).toThrow(/not in the configured allowlist/);
  });
});

describe('SSRF protection', () => {
  it('recognises loopback and private addresses', () => {
    for (const host of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '::1']) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });

  it('does not treat public addresses as private', () => {
    for (const host of ['verizon.com', '8.8.8.8', '172.32.0.1']) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });

  it('blocks the cloud metadata endpoint even if it were allowlisted', () => {
    expect(isAllowedUrl('https://169.254.169.254/latest/meta-data/', ['169.254.169.254'])).toBe(false);
  });
});
