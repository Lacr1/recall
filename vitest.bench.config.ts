import { defineConfig } from 'vitest/config'

// Performance benchmarks (plan doc 07 §6). Run with: npm run bench
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/bench/**/*.test.ts'],
    testTimeout: 1_800_000,
    setupFiles: ['tests/support/network-guard.ts']
  }
})
