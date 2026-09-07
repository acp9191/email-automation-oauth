import { getConfig } from '../config/index.js';
import { describeCredentials } from '../gmail/auth.js';
import { GmailReadClient } from '../gmail/client.js';

/* eslint-disable no-console */

/**
 * Verifies authentication and prints account-level metadata only.
 * Deliberately prints no subjects, senders or message contents.
 */
export async function gmailTestCommand(): Promise<void> {
  const config = getConfig();

  console.log('\n  Credential profiles:');
  for (const entry of describeCredentials(config)) {
    console.log(
      `    ${entry.profile.padEnd(5)} ${entry.authorized ? 'authorized' : 'NOT authorized'}  ${entry.scopes.join(' ')}`,
    );
  }

  const reader = new GmailReadClient(config);
  const profile = await reader.getProfile();

  console.log('\n  Authenticated account:');
  console.log(`    address:        ${profile.emailAddress}`);
  console.log(`    total messages: ${profile.messagesTotal}`);
  console.log(`    total threads:  ${profile.threadsTotal}`);
  console.log(`    history id:     ${profile.historyId}`);
  console.log('\n  Read access confirmed. No message contents were printed.\n');
}
