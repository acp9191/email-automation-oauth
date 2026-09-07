import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    env: {
      // Tests must never touch a real mailbox or a real .env.
      LOG_LEVEL: 'silent',
      LOG_PRETTY: 'false',
      DRY_RUN: 'true',
    },
  },
});
