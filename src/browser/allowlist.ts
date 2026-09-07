import net from 'node:net';

/**
 * URL allowlist.
 *
 * Links inside an email are attacker-controlled, so nothing in this system
 * fetches or navigates to a URL that has not passed this check first. It blocks
 * non-HTTPS schemes, credentials embedded in the URL, hosts outside the
 * configured allowlist, and the private / loopback / link-local space (SSRF).
 */

export class BlockedUrlError extends Error {
  constructor(readonly url: string, reason: string) {
    super(`Refusing to visit ${url}: ${reason}`);
    this.name = 'BlockedUrlError';
  }
}

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
];

export function isPrivateHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.internal') ||
    normalized.endsWith('.local')
  ) {
    return true;
  }
  if (net.isIPv4(normalized)) return PRIVATE_V4.some((pattern) => pattern.test(normalized));
  if (net.isIPv6(normalized)) {
    return (
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80')
    );
  }
  return false;
}

export function hostIsAllowed(host: string, allowedDomains: string[]): boolean {
  const normalized = host.toLowerCase();
  return allowedDomains.some((domain) => {
    const suffix = domain.toLowerCase();
    return normalized === suffix || normalized.endsWith(`.${suffix}`);
  });
}

/** Returns the parsed URL, or throws `BlockedUrlError`. */
export function assertAllowedUrl(rawUrl: string, allowedDomains: string[]): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError(rawUrl, 'not a valid absolute URL');
  }

  if (url.protocol !== 'https:') throw new BlockedUrlError(rawUrl, `scheme "${url.protocol}" is not https`);
  if (url.username || url.password) throw new BlockedUrlError(rawUrl, 'URL contains embedded credentials');
  if (isPrivateHost(url.hostname)) throw new BlockedUrlError(rawUrl, 'host is private/loopback/link-local');
  if (!hostIsAllowed(url.hostname, allowedDomains)) {
    throw new BlockedUrlError(rawUrl, `host "${url.hostname}" is not in the configured allowlist`);
  }
  return url;
}

export function isAllowedUrl(rawUrl: string, allowedDomains: string[]): boolean {
  try {
    assertAllowedUrl(rawUrl, allowedDomains);
    return true;
  } catch {
    return false;
  }
}
