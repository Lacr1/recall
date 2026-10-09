import { defineConfig } from '@playwright/test'

// End-to-end tests drive the built app (out/) with a fake Ollama server; run `npm run test:e2e`.
export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'tests/.tmp/e2e-results',
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']]
})
