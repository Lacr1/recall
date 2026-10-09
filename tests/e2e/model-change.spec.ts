import { expect, test } from '@playwright/test'
import { CHAT_MODEL, EMBED_MODEL } from '../../src/shared/constants'
import { FakeOllama } from '../support/fake-ollama'
import { CHOOSE_FOLDER, expectAccessible, launchRecall, resultOptions, waitForIndexed, type RecallRun } from './recall'

// S4-07: switching the search model from Settings; search keeps working while the new model re-embeds.
test.describe.configure({ mode: 'serial' })

let run: RecallRun
const ollama = new FakeOllama({ models: [EMBED_MODEL, CHAT_MODEL, 'all-minilm'] })

test.beforeAll(async () => {
  await ollama.start()
  run = await launchRecall('ai', { ollamaUrl: ollama.url })
})

test.afterAll(async () => {
  await run?.close()
  await ollama.stop()
})

test('switches the search model in the background', async () => {
  const { page } = run
  await page.getByRole('button', { name: 'Get started' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: CHOOSE_FOLDER }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Start searching' }).click()
  await waitForIndexed(page)

  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Change model…' }).click()
  await page.getByRole('combobox', { name: 'Search with' }).selectOption('all-minilm')
  ollama.embedDelayMs = 400
  await page.getByRole('button', { name: 'Switch', exact: true }).click()
  const progress = page.getByRole('progressbar', { name: 'Switching to all-minilm' })
  await expect(progress).toBeVisible()
  await expectAccessible(page, 'settings: switching search model')

  // Search still answers from the current model meanwhile.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Search' }).click()
  await page.getByRole('searchbox').fill('dishwasher warranty period')
  await expect(resultOptions(page).filter({ hasText: 'Dishwasher_DW-450_Manual.pdf' })).toBeVisible()
  await expect(page.locator('.results-meta')).toContainText('meaning + keywords')

  ollama.embedDelayMs = 0
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click()
  await expect(progress).toBeHidden({ timeout: 30_000 })
  await expect(page.getByText('all-minilm · lets Recall search by meaning')).toBeVisible()
  expect(ollama.requests.some((r) => r.path === '/api/embed' && r.model === 'all-minilm')).toBe(true)

  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Search' }).click()
  await page.getByRole('searchbox').fill('dishwasher warranty')
  await expect(resultOptions(page).filter({ hasText: 'Dishwasher_DW-450_Manual.pdf' })).toBeVisible()
})
