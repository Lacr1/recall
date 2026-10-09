import { expect, test } from '@playwright/test'
import path from 'node:path'
import { CHOOSE_FOLDER, expectAccessible, launchRecall, type RecallRun } from './recall'

// Plan 12 S8-09/S8-10: the onboarding Voice step with the switch On (fake microphone saying "Recall, find my
// resume"), the voice tip on Ready, and Settings → Voice. The voice-off path is covered by keyword-only.spec.ts.
test.describe.configure({ mode: 'serial' })

const FAKE_MIC = path.resolve(__dirname, '../fixtures/voice/fake-mic-loop.wav')
let run: RecallRun

test.beforeAll(async () => {
  run = await launchRecall('voice-onboarding', { env: { RECALL_FAKE_MIC: FAKE_MIC } })
})

test.afterAll(async () => {
  await run?.page.evaluate(() => window.recall.setVoiceSettings({ enabled: false })).catch(() => undefined)
  await run?.close()
})

test('onboarding: switching voice On opens the mic and the practice hears "Recall"', async () => {
  const { page } = run
  await page.getByRole('button', { name: 'Get started' }).click()
  await page.getByRole('button', { name: /Skip for now|Continue/ }).first().click()
  await page.getByRole('button', { name: CHOOSE_FOLDER }).click()
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page.getByRole('heading', { name: 'Talk to Recall' })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Off' })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Read replies aloud' })).toHaveCount(0)
  await page.getByRole('radio', { name: 'On' }).check()
  await expect(page.getByText('Try it: say “Recall”')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('checkbox', { name: 'Read replies aloud' })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Start Recall when Windows starts' })).not.toBeChecked()
  await expect(page.getByText('✓ Heard you')).toBeVisible({ timeout: 30_000 })
  await expectAccessible(page, 'onboarding: voice on, heard')
  await page.screenshot({ path: path.resolve(__dirname, '../.tmp/popup-shots/7-onboarding-voice.png') })
  // Read-aloud off for the rest of the run, so the test stays silent.
  await page.getByRole('checkbox', { name: 'Read replies aloud' }).uncheck()
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible()
  await expect(page.getByText('Say “Recall, find my resume”', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Start searching' }).click()
})

test('Settings → Voice shows the same switch plus mute and sensitivity', async () => {
  const { page } = run
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click()
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Voice' }) })
  await expect(section.getByRole('radio', { name: 'On' })).toBeChecked()
  await section.getByRole('checkbox', { name: 'Mute until I unmute' }).check()
  await expect(section.getByText('Muted. Recall is not listening.')).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.recall.getVoiceStatus().then((s) => s.state))).toBe('muted')
  await section.getByRole('checkbox', { name: 'Mute until I unmute' }).uncheck()
  await section.getByRole('combobox', { name: 'Wake word sensitivity' }).selectOption('lower')
  await expect.poll(() => page.evaluate(() => window.recall.getVoiceStatus().then((s) => s.settings.sensitivity))).toBe('lower')
  // Quick changes in a row must not trip over each other while the mic reopens.
  await expect.poll(() => page.evaluate(() => window.recall.getVoiceStatus().then((s) => s.state)), { timeout: 15_000 }).toBe('listening')
  await expect(section.getByRole('alert')).toHaveCount(0)
  await expect(page.getByText('a wake-word model trained on LibriSpeech', { exact: false })).toBeVisible()
  await expectAccessible(page, 'settings: voice')
  await section.screenshot({ path: path.resolve(__dirname, '../.tmp/popup-shots/8-settings-voice.png') })
  await section.getByRole('radio', { name: 'Off' }).check()
  await expect.poll(() => page.evaluate(() => window.recall.getVoiceStatus().then((s) => s.state))).toBe('off')
  await expect(section.getByText('Turn voice on to say “Recall” from any app.')).toBeVisible()
})
