import { defineConfig } from 'vitest/config'

// Tests that need a running Ollama with nomic-embed-text. Run with: npm run test:live
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/live/**/*.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    setupFiles: ['tests/support/network-guard.ts']
  }
})
