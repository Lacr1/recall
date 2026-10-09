import { expect, test } from '@playwright/test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { CHAT_MODEL } from '../../src/shared/constants'
import { FakeOllama } from '../support/fake-ollama'
import { CHOOSE_FOLDER, expectAccessible, getStatus, launchRecall, waitForIndexed, type RecallRun } from './recall'

// E2E flows 2–6 from plan doc 07 §9, against a fake Ollama that starts without the search model.
test.describe.configure({ mode: 'serial' })

let run: RecallRun
const ollama = new FakeOllama({
  models: [CHAT_MODEL],
  // Like the real model: declines when the sources don't hold the answer, otherwise cites them.
  chatAnswer: (q) =>
    /passport/i.test(q)
      ? 'NOT_ENOUGH_EVIDENCE'
      : 'You first asked for a 50% initial payment [1]. Inferred: a later version changed the milestones [2]. See also [9].'
})

test.beforeAll(async () => {
  await ollama.start()
  run = await launchRecall('ai', { ollamaUrl: ollama.url })
})

test.afterAll(async () => {
  await run?.close()
  await ollama.stop()
})

test('onboarding downloads the search model, then adds a folder', async () => {
  const { page } = run
  await page.getByRole('button', { name: 'Get started' }).click()
  await expect(page.getByText('○ Not downloaded')).toBeVisible()
  await page.getByRole('button', { name: 'Download…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Download the search model?' })
  await expect(dialog).toBeVisible()
  await expectAccessible(page, 'onboarding: download dialog')
  await dialog.getByRole('button', { name: 'Download' }).click()

  await expect(page.getByText('● Ready').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Skip for now' })).toBeHidden()
  await expectAccessible(page, 'onboarding: local AI ready')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: CHOOSE_FOLDER }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Start searching' }).click()
  await expectAccessible(page, 'search: empty')

  const status = await waitForIndexed(page)
  expect(status.ai.state).toBe('ready')
  expect(status.progress.embedTotal).toBeGreaterThan(0)
  expect(ollama.requests.some((r) => r.path === '/api/pull')).toBe(true)
})

test('suggests example searches from the indexed files, and moves the search box up for results', async () => {
  const { page } = run
  const heading = page.getByRole('heading', { name: 'Search by what you remember' })
  const examples = page.getByRole('group', { name: 'Example searches' }).getByRole('button')
  await expect
    .poll(async () => {
      const texts = await examples.allTextContents()
      return texts.length === 3 && !texts.some((t) => t.includes('50% initial payment'))
    })
    .toBe(true)

  const example = (await examples.first().textContent())!.replace(/[“”]/g, '')
  await examples.first().click()
  await expect(heading).toBeHidden()
  await expect(page.getByRole('option').first()).toBeVisible()
  await page.waitForTimeout(1800) // a search is remembered once it has rested with results
  await page.getByRole('button', { name: 'Clear search' }).click()
  await expect(heading).toBeVisible()

  const recent = page.getByRole('region', { name: 'Recent searches' })
  await expect(recent.getByRole('button', { name: example, exact: true })).toBeVisible()
  await expectAccessible(page, 'search: empty with recent searches')
  await recent.getByRole('button', { name: example, exact: true }).click()
  await expect(page.getByRole('searchbox')).toHaveValue(example)
  await page.keyboard.press('Escape')
  await recent.getByRole('button', { name: `Remove “${example}” from recent searches` }).click()
  await expect(recent).toBeHidden()
})

test('shows placeholder results while a slow search runs', async () => {
  const { page } = run
  ollama.embedDelayMs = 1500
  try {
    await page.getByRole('searchbox').fill('dishwasher warranty period')
    await expect(page.locator('.skeleton-card').first()).toBeVisible()
    await expect(page.getByRole('region', { name: 'Results' })).toHaveAttribute('aria-busy', 'true')
    await expect(page.getByRole('option').filter({ hasText: 'Dishwasher_DW-450_Manual.pdf' })).toBeVisible()
    await expect(page.locator('.skeleton-card')).toHaveCount(0)
  } finally {
    ollama.embedDelayMs = 0
  }
  await page.getByRole('button', { name: 'Clear search' }).click()
})

test('searches by meaning and keywords and explains each match', async () => {
  const { page } = run
  await page.getByRole('searchbox').fill('proposal with a 50% initial payment')
  await expect(page.locator('.results-meta')).toContainText('meaning + keywords')
  const result = page.getByRole('option').filter({ hasText: 'Acme_Proposal_v2.pdf' })
  await expect(result).toBeVisible()
  await result.click()
  const evidence = page.getByRole('complementary', { name: 'Evidence' })
  await expect(evidence.getByRole('heading', { name: 'Acme_Proposal_v2.pdf' })).toBeVisible()
  await expect(evidence.getByRole('heading', { name: 'Why it matched' })).toBeVisible()
  await expect(evidence.locator('.passage mark').first()).toBeVisible()
  await expectAccessible(page, 'search: hybrid results')

  await page.getByRole('searchbox').fill('Acme_Proposal_v3')
  await expect(page.getByRole('option').filter({ hasText: 'Acme_Proposal_v3' }).getByText('2 copies')).toBeVisible()
})

test('opens and reveals files through the open-file guard', async () => {
  const { page } = run
  await page.getByRole('searchbox').fill('dishwasher warranty period')
  await page.getByRole('option').filter({ hasText: 'Dishwasher_DW-450_Manual.pdf' }).click()
  const evidence = page.getByRole('complementary', { name: 'Evidence' })
  await evidence.getByRole('button', { name: 'Open' }).click()
  await evidence.getByRole('button', { name: 'Show in folder' }).click()
  const expected = path.join(run.corpus, 'manuals', 'Dishwasher_DW-450_Manual.pdf')
  await expect.poll(run.opened).toEqual([expected, 'reveal:' + expected])

  await evidence.getByRole('button', { name: 'Details' }).click()
  const details = page.getByRole('dialog', { name: 'Document details' })
  await expect(details.getByText(/Match 1 of \d+/)).toBeVisible()
  await details.getByRole('button', { name: 'Next match' }).click()
  await expect(details.getByText(/Match 2 of \d+/)).toBeVisible()
  await expectAccessible(page, 'details')
  await page.keyboard.press('Escape')
  await expect(details).toBeHidden()
})

test('Ask answers with citations and declines without evidence', async () => {
  const { page } = run
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Ask' }).click()
  const input = page.getByRole('textbox', { name: 'Ask a question about your files' })
  await input.fill('What payment terms did I propose to Acme, and did they change?')
  await page.locator('.ask-form').getByRole('button', { name: 'Ask' }).click()
  await expect(page.locator('.disclaimer')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Source 1' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Source 9' })).toHaveCount(0)
  await expect(page.getByText('Removed citations to sources that don’t exist: [9]')).toBeVisible()
  await expect(page.locator('.inferred')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Cited sources' })).toBeVisible()
  await expectAccessible(page, 'ask: answer')

  // The model declines: "expire" matches a passage, so retrieval lets the question through.
  await input.fill('When does my passport expire?')
  await page.locator('.ask-form').getByRole('button', { name: 'Ask' }).click()
  await expect(page.locator('.insufficient')).toBeVisible()
  await expect(page.locator('.answer-text')).toHaveCount(0)

  // Retrieval declines: nothing matches, so the model is never asked.
  const chats = ollama.requests.filter((r) => r.path === '/api/chat').length
  await input.fill('Who won the chess olympiad?')
  await page.locator('.ask-form').getByRole('button', { name: 'Ask' }).click()
  await expect(page.locator('.answer-q')).toHaveText('Who won the chess olympiad?')
  await expect(page.locator('.insufficient')).toBeVisible()
  expect(ollama.requests.filter((r) => r.path === '/api/chat').length).toBe(chats)
})

test('falls back to keywords when Ollama stops, and recovers on its own', async () => {
  const { page } = run
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Search' }).click()
  await ollama.stop()
  await page.getByRole('searchbox').fill('emails landing in junk folder')
  await expect(page.getByRole('status').filter({ hasText: 'Meaning-based search is off' })).toBeVisible()
  await expect(page.getByRole('contentinfo')).toContainText('Keyword-only')
  await page.getByRole('searchbox').fill('emails landing in the junk folder')
  await expect(page.locator('.results-meta')).toContainText('keywords only')
  await expectAccessible(page, 'search: AI went away')

  await ollama.start()
  await expect(page.getByRole('status').filter({ hasText: 'Meaning-based search is off' })).toBeHidden()
  await expect(page.getByRole('contentinfo')).toContainText('Local AI ready')
  await page.getByRole('searchbox').fill('emails landing in junk folder again')
  await expect(page.locator('.results-meta')).toContainText('meaning + keywords')
})

test('lists unreadable files with reasons and retries them', async () => {
  const { page } = run
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Folders' }).click()
  const failures = page.locator('.failures')
  await expect(failures.getByText('broken.pdf')).toBeVisible()
  await expect(failures.getByText('scanned-receipt.pdf')).toBeVisible()
  await expect(failures.locator('li')).toHaveCount(2)
  await expectAccessible(page, 'folders')
  await page.getByRole('button', { name: 'Retry all' }).click()
  await expect(failures.getByText('broken.pdf')).toBeVisible()
})

test('removing a folder removes its results but not the files', async () => {
  const { page } = run
  await page.getByRole('button', { name: 'Remove from Recall…' }).click()
  const dialog = page.getByRole('dialog')
  await expectAccessible(page, 'folders: remove dialog')
  await dialog.getByRole('button', { name: 'Remove from Recall' }).click()
  await expect(page.getByText('No folders yet.')).toBeVisible()
  await expect.poll(async () => (await getStatus(page)).progress.filesTotal).toBe(0)

  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Search' }).click()
  await expect(page.getByRole('heading', { name: 'Recall doesn’t have any folders yet' })).toBeVisible()
  await page.getByRole('searchbox').fill('dishwasher warranty period')
  await expect(page.getByText('No files matched')).toBeVisible()
  expect(existsSync(path.join(run.corpus, 'manuals', 'Dishwasher_DW-450_Manual.pdf'))).toBe(true)
})

test('delete all data returns to onboarding', async () => {
  const { page } = run
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByText(run.dataDir)).toBeVisible()
  await expectAccessible(page, 'settings')
  await page.getByRole('button', { name: 'Delete all Recall data…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete all Recall data?' })
  const confirm = dialog.getByRole('button', { name: 'Delete everything' })
  await expect(confirm).toBeDisabled()
  await dialog.getByRole('textbox', { name: 'Type DELETE to confirm' }).fill('DELETE')
  await expectAccessible(page, 'settings: delete dialog')
  await confirm.click()

  await expect(page.getByRole('button', { name: 'Get started' })).toBeVisible()
  const status = await getStatus(page)
  expect(status.folders).toHaveLength(0)
  expect(status.progress.filesTotal).toBe(0)
  // Only what the restarted engine creates is left: an empty database and an empty folder list.
  expect(readdirSync(run.dataDir).filter((f) => !f.startsWith('recall.db'))).toEqual(['folders.json'])
  expect(JSON.parse(readFileSync(path.join(run.dataDir, 'folders.json'), 'utf8')).folders).toEqual([])
})
