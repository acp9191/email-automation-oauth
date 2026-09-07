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

/**
 * Interactive consent via a loopback redirect on 127.0.0.1.
 * The authorization code never leaves the machine.
 */
export async function authorizeInteractive(
  config: Config,
  profile: ScopeProfile,
): Promise<void> {
  const log = childLogger({ component: 'gmail.auth', profile });
  const client = newClient(config);
  const state = crypto.randomBytes(16).toString('hex');

  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES[profile],
    state,
  });

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url ?? '/', `http://127.0.0.1:${config.google.oauthPort}`);
      if (requestUrl.pathname !== '/oauth2callback') {
        res.writeHead(404).end('Not found');
        return;
      }
      const returnedState = requestUrl.searchParams.get('state');
      const returnedCode = requestUrl.searchParams.get('code');
      const error = requestUrl.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end(`Authorization failed: ${error}`);
        server.close();
        reject(new AuthError(`Google returned an error: ${error}`));
        return;
      }
      if (returnedState !== state) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('State mismatch.');
        server.close();
        reject(new AuthError('OAuth state mismatch — aborting.'));
        return;
      }
      if (!returnedCode) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('Missing code.');
        server.close();
        reject(new AuthError('No authorization code returned.'));
        return;
      }

      res.writeHead(200, { 'content-type': 'text/html' }).end(
        `<html><body style="font-family:system-ui;padding:3rem">
           <h2>Authorized: ${profile} profile</h2>
           <p>Scope: <code>${SCOPES[profile].join(' ')}</code></p>
           <p>You can close this tab and return to the terminal.</p>
         </body></html>`,
      );
      server.close();
      resolve(returnedCode);
    });

    server.on('error', reject);
    server.listen(config.google.oauthPort, '127.0.0.1', () => {
      log.info({ port: config.google.oauthPort }, 'waiting for Google consent redirect');
      // eslint-disable-next-line no-console
      console.log(`\nOpen this URL to authorize the "${profile}" profile:\n\n${url}\n`);
      openBrowser(url);
    });
  });

  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new AuthError(
      'Google did not return a refresh token. Revoke the app at https://myaccount.google.com/permissions and re-run auth.',
    );
  }
  writeToken(config, profile, tokens as Record<string, unknown>);
  log.info({ file: tokenPath(config, profile) }, 'stored credentials (0600)');
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
