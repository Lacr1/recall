import { expect, test } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { launchRecall, type RecallRun } from './recall'
import type { VoiceStatus } from '../../src/shared/voice'

// Plan 12 S8-03/S8-04: microphone capture through Chromium's fake device (a looping WAV that says
// "Recall, find my resume"), the audio-only permission, voice settings, mute, close-to-tray and delete-all.
// Needs resources/voice (node scripts/fetch-voice-models.mjs).
test.describe.configure({ mode: 'serial' })

const FAKE_MIC = path.resolve(__dirname, '../fixtures/voice/fake-mic-loop.wav')
let run: RecallRun

const voiceStatus = () => run.page.evaluate(() => window.recall.getVoiceStatus())
const voiceState = async () => (await voiceStatus()).state
const voiceEvents = () => run.page.evaluate(() => (window as unknown as { __voice: { event: string; rms?: number }[] }).__voice)
// The main window, found by its page: the voice popup is a second window.
const windowVisible = () => run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html'))?.isVisible() ?? false)

test.beforeAll(async () => {
  run = await launchRecall('voice', { env: { RECALL_FAKE_MIC: FAKE_MIC } })
  await run.page.evaluate(() => {
    const w = window as unknown as { __voice: unknown[] }
    w.__voice = []
    window.recall.onEvent((e) => {
      if (e.event.startsWith('voice')) w.__voice.push(e)
    })
  })
})

test.afterAll(async () => {
  await run?.page.evaluate(() => window.recall.setVoiceSettings({ enabled: false })).catch(() => undefined)
  await run?.close()
})

test('voice is off by default and the microphone stays closed', async () => {
  const s: VoiceStatus = await voiceStatus()
  expect(s.state).toBe('off')
  expect(s.settings.enabled).toBe(false)
  expect(await run.app.evaluate(({ app }) => app.getAppMetrics().some((m) => m.name === 'Recall Voice'))).toBe(false)
})

test('turning voice on opens the mic and hears the wake word', async () => {
  await run.page.evaluate(() => window.recall.setVoiceSettings({ enabled: true }))
  await expect.poll(voiceState, { timeout: 30_000 }).toBe('listening')
  await run.page.evaluate(() => window.recall.setVoiceMeter(true))
  await expect.poll(async () => (await voiceEvents()).some((e) => e.event === 'voiceLevel' && (e.rms ?? 0) > 0.001), { timeout: 15_000 }).toBe(true)
  await expect.poll(async () => (await voiceEvents()).some((e) => e.event === 'voiceWake'), { timeout: 30_000 }).toBe(true)
  await run.page.evaluate(() => window.recall.setVoiceMeter(false))
  const saved = JSON.parse(readFileSync(path.join(run.dataDir, 'voice-settings.json'), 'utf8'))
  expect(saved.enabled).toBe(true)
})

test('only microphone audio is permitted', async () => {
  const video = await run.page.evaluate(() =>
    navigator.mediaDevices.getUserMedia({ video: true }).then(
      () => 'granted',
      (e: Error) => e.name
    )
  )
  expect(video).toBe('NotAllowedError')
})

test('mute closes the microphone and unmute reopens it', async () => {
  await run.page.evaluate(() => window.recall.setVoiceSettings({ muted: true }))
  await expect.poll(voiceState).toBe('muted')
  await run.page.evaluate(() => window.recall.setVoiceSettings({ muted: false }))
  await expect.poll(voiceState, { timeout: 15_000 }).toBe('listening')
})

test('closing the window keeps Recall listening in the tray', async () => {
  await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html'))!.close())
  await expect.poll(windowVisible).toBe(false)
  expect(await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html')) !== undefined)).toBe(true)
  expect(await voiceState()).toBe('listening')
  // The mic keeps working while hidden: the wake word is still heard.
  await run.page.evaluate(() => ((window as unknown as { __voice: unknown[] }).__voice.length = 0))
  await expect.poll(async () => (await voiceEvents()).some((e) => e.event === 'voiceWake'), { timeout: 30_000 }).toBe(true)
  await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html'))!.show())
})

test('rejects settings it does not know and keeps valid ones', async () => {
  const s = await run.page.evaluate(() => window.recall.setVoiceSettings({ sensitivity: 'loud', enabled: 'yes' } as never))
  expect(s.settings.enabled).toBe(true)
  expect(s.settings.sensitivity).toBe('normal')
})

test('delete all data turns voice off', async () => {
  await run.page.evaluate(() => window.recall.deleteAllData())
  await run.page.waitForLoadState('domcontentloaded')
  await expect.poll(async () => run.page.evaluate(() => window.recall.getVoiceStatus().then((s) => s.state)).catch(() => 'reloading'), { timeout: 30_000 }).toBe('off')
  expect(existsSync(path.join(run.dataDir, 'voice-settings.json'))).toBe(false)
})

test('with voice off, closing the window quits', async () => {
  const closed = new Promise<void>((r) => run.app.once('close', () => r()))
  await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html'))!.close())
  await closed
})
