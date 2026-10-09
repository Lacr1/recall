import { expect, test } from '@playwright/test'
import path from 'node:path'
import { FakeOllama } from '../support/fake-ollama'
import { CHOOSE_FOLDER, expectAccessible, launchRecall, tabTo, waitForIndexed, type RecallRun } from './recall'

// E2E flow 1 (first run without local AI → keyword search), driven only by keyboard (flow 7),
// plus the renderer security checks from plan doc 07 §7.
test.describe.configure({ mode: 'serial' })

let run: RecallRun

test.beforeAll(async () => {
  // Start and stop a fake server to get a loopback port where nothing is listening.
  const down = new FakeOllama()
  await down.start()
  await down.stop()
  run = await launchRecall('keyword', { ollamaUrl: down.url })
})

test.afterAll(async () => {
  await run?.close()
})

test('onboarding without local AI, by keyboard only', async () => {
  const { page } = run
  await expect(page.getByRole('heading', { name: 'Welcome to Recall' })).toBeVisible()
  await expectAccessible(page, 'onboarding: welcome')
  await expect(page.getByRole('button', { name: 'Get started' })).toBeFocused()
  await page.keyboard.press('Enter')

  await expect(page.getByRole('heading', { name: 'Turn on smart search' })).toBeVisible()
  await expect(page.locator('.ai-state').first()).toHaveText(/Installed, not running|Not installed/)
  await expectAccessible(page, 'onboarding: local AI missing')
  await tabTo(page, 'Skip')
  await page.keyboard.press('Enter')

  await expect(page.getByRole('heading', { name: 'Choose folders to remember' })).toBeVisible()
  await expectAccessible(page, 'onboarding: folders')
  await tabTo(page, CHOOSE_FOLDER)
  await page.keyboard.press('Enter')
  await expect(page.getByText(run.corpus)).toBeVisible()
  await tabTo(page, 'Continue')
  await page.keyboard.press('Enter')

  await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible()
  await expectAccessible(page, 'onboarding: ready')
  await tabTo(page, 'Start searching')
  await page.keyboard.press('Enter')

  await expect(page.getByRole('searchbox', { name: 'Search your files' })).toBeFocused()
})

test('keyword search works and says meaning search is off', async () => {
  const { page } = run
  await waitForIndexed(page)
  await page.keyboard.type('invoice due date')
  await expect(page.locator('.results-meta')).toContainText('keywords only')
  await expect(page.getByRole('status').filter({ hasText: 'Meaning-based search is off' })).toBeVisible()
  await expect(page.getByRole('option').first()).toContainText('invoice-2025-118.txt')
  await expectAccessible(page, 'search: keyword-only results')

  // Keyboard: Enter opens the selected file, Ctrl+Enter shows it in its folder, Escape clears.
  await page.keyboard.press('Enter')
  await page.keyboard.press('Control+Enter')
  const expected = path.join(run.corpus, 'clients', 'bluebird', 'invoice-2025-118.txt')
  await expect.poll(run.opened).toEqual([expected, 'reveal:' + expected])
  await page.keyboard.press('Escape')
  await expect(page.getByRole('searchbox')).toHaveValue('')

  await page.keyboard.press('Control+,')
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible() // Ctrl+K only works on the search screen
})

test('renderer has no Node access, network or new windows', async () => {
  const { app, page } = run
  const globals = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>
    return { require: typeof w.require, process: typeof w.process, module: typeof w.module, recall: typeof w.recall }
  })
  expect(globals).toEqual({ require: 'undefined', process: 'undefined', module: 'undefined', recall: 'object' })

  const prefs = await app.evaluate(({ BrowserWindow }) => {
    // Internal Electron API (not in the typings): the preferences the renderer was actually created with.
    const wc = BrowserWindow.getAllWindows()[0].webContents as unknown as { getLastWebPreferences(): Record<string, unknown> | null }
    const p = wc.getLastWebPreferences()
    return { sandbox: p?.sandbox, contextIsolation: p?.contextIsolation, nodeIntegration: p?.nodeIntegration }
  })
  expect(prefs).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false })

  // CSP and the session filter block these before any request leaves the machine.
  expect(await page.evaluate(() => fetch('https://example.com/').then(() => 'loaded', () => 'blocked'))).toBe('blocked')
  expect(await page.evaluate(() => window.open('https://example.com/') === null)).toBe(true)
  const before = page.url()
  await page.evaluate(() => {
    location.href = 'https://example.com/'
  })
  await page.waitForTimeout(500)
  expect(page.url()).toBe(before)
  expect(app.windows()).toHaveLength(1)
})
