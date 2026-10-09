import { defineConfig } from '@playwright/test'

// Network audit (S3-07): `npm run audit:network`. Needs Ollama running with the search model.
export default defineConfig({
  testDir: 'tests/audit',
  outputDir: 'tests/.tmp/audit-results',
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [['list']]
})
