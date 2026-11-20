import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup-page-globals.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Les tests de console ouvrent des consoles de test et passent par le verrou unique du pilote : en série.
    fileParallelism: false,
  },
});
