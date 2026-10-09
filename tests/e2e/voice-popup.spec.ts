import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { FakeOllama } from '../support/fake-ollama'
import { expectAccessible, launchRecall, waitForIndexed, type RecallRun } from './recall'

// Plan 12 S8-06/S8-07/S8-08: the popup and the spoken exchange, driven through the test hook (wake word and what
// was "said"); speech recognition itself is covered by voice.spec.ts. The clipboard is recorded, not written,
// and read-aloud is off so the test run is silent.
test.describe.configure({ mode: 'serial' })

const SHOTS = path.resolve(__dirname, '../.tmp/popup-shots')
let run: RecallRun
const ollama = new FakeOllama({
  chatAnswer: () => 'You asked Acme for a 50% initial payment [1]. Inferred: the later version moved it to milestones [2].'
})

const wake = () => run.app.evaluate(() => (globalThis as unknown as { __recallVoice: { wake(): void } }).__recallVoice.wake())
const say = (text: string) => run.app.evaluate((_e, t) => (globalThis as unknown as { __recallVoice: { say(t: string): void } }).__recallVoice.say(t), text)
const clipboard = () => run.app.evaluate(() => (globalThis as unknown as { __clip: string[] }).__clip)
const popupWindow = () =>
  run.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('popup.html'))
    return w ? { visible: w.isVisible(), focused: w.isFocused(), bounds: w.getBounds() } : undefined
  })
let popup: Page

async function shot(name: string) {
  await popup.waitForTimeout(250)
  await popup.screenshot({ path: path.join(SHOTS, `${name}.png`), omitBackground: true })
}

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true })
  await ollama.start()
  run = await launchRecall('voice-popup', { ollamaUrl: ollama.url })
  await run.app.evaluate(({ clipboard }) => {
    const g = globalThis as unknown as { __clip: string[] }
    g.__clip = []
    clipboard.writeText = async (t: string) => void g.__clip.push(t)
  })
  const { page } = run
  await page.evaluate(() => window.recall.addFolder())
  await page.evaluate(() => localStorage.setItem('recall.onboarded', '1'))
  await page.reload()
  await waitForIndexed(page)
  await page.evaluate(() => window.recall.setVoiceSettings({ readAloud: false }))
})

test.afterAll(async () => {
  await run?.close()
  await ollama.stop()
})

test('the wake word shows the prompt near the pointer without taking focus', async () => {
  await wake()
  await expect.poll(async () => (await popupWindow())?.visible).toBe(true)
  popup = run.app.windows().find((p) => p.url().endsWith('popup.html'))!
  await expect(popup.locator('.title')).toHaveText(/What can I find for you|What do you need|How can I help/)
  await expect(popup.locator('.pill')).toContainText('Listening')
  expect((await popupWindow())!.focused).toBe(false)
  await expectAccessible(popup, 'popup: prompt')
  await shot('1-prompt')
})

test('a file request copies the best match and lists the others', async () => {
  await say('Yeah, find the dishwasher manual')
  await expect(popup.locator('.hit-name')).toHaveText('Dishwasher_DW-450_Manual.pdf')
  await expect(popup.locator('.chip-ok')).toContainText('Copied')
  await expect(popup.locator('.heard')).toHaveText('“Yeah, find the dishwasher manual”')
  expect((await clipboard()).at(-1)).toBe(path.join(run.corpus, 'manuals', 'Dishwasher_DW-450_Manual.pdf'))
  await expect(popup.getByRole('button', { name: 'Show in folder' })).toBeVisible()
  await expectAccessible(popup, 'popup: file result')
  await shot('2-file-result')
  await popup.emulateMedia({ colorScheme: 'dark' })
  await expectAccessible(popup, 'popup: file result, dark')
  await shot('2-file-result-dark')
  await popup.emulateMedia({ colorScheme: 'light' })
})

test('"the second one" copies another match', async () => {
  const others = await popup.locator('.other-name').allTextContents()
  test.skip(others.length === 0, 'only one match on this corpus')
  await say('the second one')
  await expect(popup.locator('.note')).toHaveText('Copied the second match instead.')
  await expect(popup.locator('.hit-name')).toHaveText(others[0])
  expect(path.basename((await clipboard()).at(-1)!)).toBe(others[0])
  await shot('3-second-match')
})

test('Show in folder reveals the copied file through the guard', async () => {
  await popup.getByRole('button', { name: 'Show in folder' }).click()
  await expect.poll(async () => (await run.opened()).at(-1)).toMatch(/^reveal:/)
})

test('Esc closes the popup', async () => {
  await popup.keyboard.press('Escape')
  await expect.poll(async () => (await popupWindow())?.visible).toBe(false)
})

test('a folder request copies the folder path', async () => {
  await wake()
  await say('Recall, find my recipes folder')
  await expect(popup.locator('.hit-name')).toHaveText('recipes')
  expect((await clipboard()).at(-1)).toBe(path.join(run.corpus, 'personal', 'recipes'))
  await shot('4-folder-result')
  await popup.getByRole('button', { name: 'Show in folder' }).click()
  await expect.poll(async () => (await run.opened()).at(-1)).toBe(path.join(run.corpus, 'personal', 'recipes'))
  await popup.getByRole('button', { name: 'Close' }).click()
  await expect.poll(async () => (await popupWindow())?.visible).toBe(false)
})

test('a question is answered from the files with sources', async () => {
  await wake()
  await say('yes')
  await expect(popup.locator('.title')).toHaveText('Sure, go ahead.')
  await say('What payment terms did I propose to Acme?')
  await expect(popup.locator('.answer')).toContainText('50% initial payment')
  await expect(popup.locator('.caret')).toHaveCount(0)
  await expect(popup.locator('.cite').first()).toHaveText('1')
  await expect(popup.locator('.others .other').first()).toBeVisible()
  await expectAccessible(popup, 'popup: answer')
  await shot('5-answer')
  await popup.locator('.others .other').first().click()
  await expect.poll(async () => (await run.opened()).length).toBeGreaterThan(1)
})

test('Open in Recall hands the request to the main window', async () => {
  await wake()
  await say('find the dishwasher manual')
  await expect(popup.locator('.hit-name')).toBeVisible()
  await popup.getByRole('button', { name: 'Open in Recall' }).click()
  await expect.poll(async () => (await popupWindow())?.visible).toBe(false)
  await expect(run.page.getByRole('searchbox', { name: 'Search your files' })).toHaveValue('dishwasher manual')
})

test('"no" closes the prompt, and silence closes it after 8 seconds', async () => {
  await wake()
  await expect.poll(async () => (await popupWindow())?.visible).toBe(true)
  await say('no thanks')
  await expect.poll(async () => (await popupWindow())?.visible).toBe(false)
  await wake()
  await expect.poll(async () => (await popupWindow())?.visible).toBe(true)
  await expect.poll(async () => (await popupWindow())?.visible, { timeout: 12_000 }).toBe(false)
})

test('a request without a strong match copies nothing until one is picked', async () => {
  const before = (await clipboard()).length
  await wake()
  await say('find the qwxzv')
  await expect(popup.locator('.title')).toHaveText(/No strong match|couldn't find/)
  await expect(popup.getByRole('button', { name: 'Open in Recall' })).toBeVisible()
  expect((await clipboard()).length).toBe(before)
  await expectAccessible(popup, 'popup: weak or no match')
  await shot('6-weak-match')
  if ((await popup.locator('.others .other').count()) > 0) {
    await say('the first one')
    await expect(popup.locator('.chip-ok')).toBeVisible()
    expect((await clipboard()).length).toBe(before + 1)
  }
})
