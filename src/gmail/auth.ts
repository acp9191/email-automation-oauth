import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { requireGoogleCredentials, type Config } from '../config/index.js';
import { childLogger } from '../logging/index.js';

/**
 * OAuth for Gmail, split into two independent least-privilege profiles.
 *
 *   read → gmail.readonly   (detection, bodies, attachments; CANNOT send)
 *   send → gmail.send       (sending only; CANNOT read a single message)
 *
 * They are separate consents with separate stored tokens, so a bug in the
 * detection path has no credential capable of sending mail, and vice versa.
 * Neither scope can delete a message or modify the mailbox.
 */

export type ScopeProfile = 'read' | 'send';

export const SCOPES: Record<ScopeProfile, string[]> = {
  read: ['https://www.googleapis.com/auth/gmail.readonly'],
  send: ['https://www.googleapis.com/auth/gmail.send'],
};

interface StoredToken {
  profile: ScopeProfile;
  scopes: string[];
  authorizedAt: string;
  tokens: Record<string, unknown>;
}

export class AuthError extends Error {}

function tokenPath(config: Config, profile: ScopeProfile): string {
  return path.join(config.tokenDir, `gmail-${profile}.json`);
}

function redirectUri(config: Config): string {
  return `http://127.0.0.1:${config.google.oauthPort}/oauth2callback`;
}

function newClient(config: Config): OAuth2Client {
  requireGoogleCredentials(config);
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    redirectUri(config),
  );
}

function writeToken(config: Config, profile: ScopeProfile, tokens: Record<string, unknown>): void {
  fs.mkdirSync(config.tokenDir, { recursive: true, mode: 0o700 });
  const file = tokenPath(config, profile);
  const payload: StoredToken = {
    profile,
    scopes: SCOPES[profile],
    authorizedAt: new Date().toISOString(),
    tokens,
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function readToken(config: Config, profile: ScopeProfile): StoredToken | undefined {
  const file = tokenPath(config, profile);
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as StoredToken;
}

export function hasCredentials(config: Config, profile: ScopeProfile): boolean {
  return readToken(config, profile) !== undefined;
}

/** Returns an authorised client, refreshing and re-persisting tokens as needed. */
export function getAuthorizedClient(config: Config, profile: ScopeProfile): OAuth2Client {
  const stored = readToken(config, profile);
  if (!stored) {
    throw new AuthError(
      `No stored Gmail credentials for the "${profile}" profile. Run: npm run auth -- --profile ${profile}`,
    );
  }
  const client = newClient(config);
  client.setCredentials(stored.tokens);

  // Google issues a fresh access token on refresh; persist it so the next
  // process start does not need a network round trip.
  client.on('tokens', (tokens) => {
    const merged: Record<string, unknown> = { ...stored.tokens, ...tokens };
    // A refresh response omits the refresh token — keep the one we already hold,
    // otherwise the next run would have to prompt for consent again.
    if (merged.refresh_token == null && stored.tokens.refresh_token != null) {
      merged.refresh_token = stored.tokens.refresh_token;
    }
    writeToken(config, profile, merged);
  });

  return client;
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${command} "${url}"`, () => {
    // If it fails the user still has the URL printed to the terminal.
  });
}

function page(title: string, body: string, refreshTo?: string): string {
  const refresh = refreshTo ? `<meta http-equiv="refresh" content="1;url=${refreshTo}">` : '';
  return `<html><head>${refresh}</head><body style="font-family:system-ui;padding:3rem">
    <h2>${title}</h2>${body}</body></html>`;
}

/**
 * Interactive consent via a loopback redirect on 127.0.0.1.
 * The authorization code never leaves the machine.
 *
 * Every requested profile is authorized through ONE server in ONE browser tab:
 * each profile still gets its own consent and its own token, but after the first
 * consent the tab moves straight on to the next. Starting a fresh server per
 * profile on the same port broke — the browser reused its keep-alive connection
 * to the previous server, whose handler then rejected the next profile's state.
 */
export async function authorizeInteractive(
  config: Config,
  profiles: ScopeProfile[],
): Promise<void> {
  const log = childLogger({ component: 'gmail.auth' });
  const client = newClient(config);

  // One single-use state per profile; the state is what tells us which consent came back.
  const pending = profiles.map((profile) => {
    const state = crypto.randomBytes(16).toString('hex');
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES[profile],
      state,
    });
    return { profile, state, url };
  });

  const codes = await new Promise<Map<ScopeProfile, string>>((resolve, reject) => {
    const received = new Map<ScopeProfile, string>();

    const finish = (outcome: () => void): void => {
      server.close();
      server.closeAllConnections();
      outcome();
    };

    const server = http.createServer((req, res) => {
      // Never leave a keep-alive socket behind for the browser to reuse.
      res.setHeader('connection', 'close');

      const requestUrl = new URL(req.url ?? '/', `http://127.0.0.1:${config.google.oauthPort}`);
      if (requestUrl.pathname !== '/oauth2callback') {
        res.writeHead(404).end('Not found');
        return;
      }
      const returnedState = requestUrl.searchParams.get('state');
      const returnedCode = requestUrl.searchParams.get('code');
      const error = requestUrl.searchParams.get('error');

      // A callback carrying an unknown or already-used state (a reloaded tab, an old
      // URL from scrollback) is rejected but does not end the flow — otherwise any
      // stale redirect would abort before the real consent arrives.
      const entry = pending.find((p) => p.state === returnedState && !received.has(p.profile));
      if (!entry) {
        log.warn('ignored callback with unknown or reused OAuth state (stale or foreign redirect)');
        res.writeHead(400, { 'content-type': 'text/html' }).end(
          page(
            'This link is stale',
            '<p>It is not from the authorization currently in progress. Close this tab and use the browser tab that <code>npm run auth</code> opened most recently.</p>',
          ),
        );
        return;
      }
      if (error) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end(`Authorization failed: ${error}`);
        finish(() => reject(new AuthError(`Google returned an error for "${entry.profile}": ${error}`)));
        return;
      }
      if (!returnedCode) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('Missing code.');
        finish(() => reject(new AuthError(`No authorization code returned for "${entry.profile}".`)));
        return;
      }

      received.set(entry.profile, returnedCode);
      log.info({ profile: entry.profile }, 'consent received');
      const next = pending.find((p) => !received.has(p.profile));
      const scopeLine = `<p>Scope: <code>${SCOPES[entry.profile].join(' ')}</code></p>`;

      if (next) {
        res.writeHead(200, { 'content-type': 'text/html' }).end(
          page(
            `Authorized: ${entry.profile} profile`,
            `${scopeLine}<p>Continuing to the separate <strong>${next.profile}</strong> consent&hellip;</p>
             <p><a href="${next.url}">Continue now</a></p>`,
            next.url,
          ),
        );
        return;
      }

      res.writeHead(200, { 'content-type': 'text/html' }).end(
        page(
          `Authorized: ${profiles.join(' + ')}`,
          `${scopeLine}<p>You can close this tab and return to the terminal.</p>`,
        ),
      );
      finish(() => resolve(received));
    });

    server.on('error', reject);
    server.listen(config.google.oauthPort, '127.0.0.1', () => {
      log.info({ port: config.google.oauthPort }, 'waiting for Google consent redirect');
      const first = pending[0]!;
      // eslint-disable-next-line no-console
      console.log(
        `\nOpening your browser to authorize: ${profiles.join(', ')}` +
          (profiles.length > 1 ? ' (one tab; each consent follows the previous)' : '') +
          `\nIf it does not open, visit:\n\n${first.url}\n`,
      );
      openBrowser(first.url);
    });
  });

  for (const { profile } of pending) {
    const { tokens } = await client.getToken(codes.get(profile)!);
    if (!tokens.refresh_token) {
      throw new AuthError(
        'Google did not return a refresh token. Revoke the app at https://myaccount.google.com/permissions and re-run auth.',
      );
    }
    writeToken(config, profile, tokens as Record<string, unknown>);
    log.info({ profile, file: tokenPath(config, profile) }, 'stored credentials (0600)');
  }
}

/** Non-secret summary of what is currently authorized, for `status` output. */
export function describeCredentials(
  config: Config,
): Array<{ profile: ScopeProfile; authorized: boolean; scopes: string[]; authorizedAt: string | null }> {
  return (['read', 'send'] as ScopeProfile[]).map((profile) => {
    const stored = readToken(config, profile);
    return {
      profile,
      authorized: stored !== undefined,
      scopes: SCOPES[profile],
      authorizedAt: stored?.authorizedAt ?? null,
    };
  });
}
