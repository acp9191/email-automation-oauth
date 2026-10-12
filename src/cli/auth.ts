import { getConfig } from '../config/index.js';
import { authorizeInteractive, describeCredentials, SCOPES, type ScopeProfile } from '../gmail/auth.js';

/* eslint-disable no-console */

export async function authCommand(profileArg: string | undefined): Promise<void> {
  const config = getConfig();
  const requested = (profileArg ?? 'all').toLowerCase();

  const profiles: ScopeProfile[] =
    requested === 'all' ? ['read', 'send'] : requested === 'read' || requested === 'send' ? [requested] : [];

  if (profiles.length === 0) {
    throw new Error(`--profile must be one of: read, send, all (got "${profileArg}")`);
  }

  console.log('\n  Authorizing Gmail with two separate least-privilege consents:');
  for (const profile of profiles) {
    console.log(`    ${profile.padEnd(5)} → ${SCOPES[profile].join(' ')}`);
  }
  console.log('');

  await authorizeInteractive(config, profiles);
  for (const profile of profiles) {
    console.log(`  ✓ ${profile} profile authorized`);
  }
  console.log('');

  console.log('  Current credential state:');
  for (const entry of describeCredentials(config)) {
    console.log(
      `    ${entry.profile.padEnd(5)} ${entry.authorized ? 'authorized' : 'NOT authorized'}` +
        `${entry.authorizedAt ? `  (${entry.authorizedAt})` : ''}`,
    );
  }
  console.log(`\n  Tokens stored with 0600 permissions in ${config.tokenDir}\n`);
}
