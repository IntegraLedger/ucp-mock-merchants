import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node', // Node 20+ provides Web Crypto (globalThis.crypto.subtle)
  },
});
