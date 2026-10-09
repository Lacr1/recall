// Main-process voice rules (plan 12 S8-03/S8-04): the permission filter, settings validation and storage,
// the login item, mic error mapping and the tray icon.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { allowPermissionCheck, allowPermissionRequest } from '../../src/main/permissions'
import { loginItemFor, parseVoiceSettings, readVoiceSettings, voiceSettingsPatch, writeVoiceSettings } from '../../src/main/voice/settings'
import { drawTrayIcon, encodePng, trayTooltip } from '../../src/main/voice/tray-icon'
import { DEFAULT_VOICE_SETTINGS, micProblemFromError } from '../../src/shared/voice'

const APP = 'file:///C:/Program%20Files/Recall/resources/app.asar/out/renderer/index.html'

describe('permissions', () => {
  const req = (over: Partial<Parameters<typeof allowPermissionRequest>[0]>) =>
    allowPermissionRequest({ permission: 'media', fromMainWindow: true, url: APP, mediaTypes: ['audio'], ...over })

  it('grants microphone audio to the main window page', () => {
    expect(req({})).toBe(true)
  })

  it.each([
    ['video', { mediaTypes: ['video'] }],
    ['audio and video', { mediaTypes: ['audio', 'video'] }],
    ['no media type', { mediaTypes: [] }],
    ['another window (the popup)', { fromMainWindow: false }],
    ['a remote page', { url: 'https://example.com/' }],
    ['notifications', { permission: 'notifications' }],
    ['screen capture', { permission: 'display-capture' }],
    ['geolocation', { permission: 'geolocation' }]
  ])('denies %s', (_name, over) => {
    expect(req(over as object)).toBe(false)
  })

  it('allows the dev server only when it is the dev URL', () => {
    expect(req({ url: 'http://localhost:5173/', devUrl: 'http://localhost:5173' })).toBe(true)
    expect(req({ url: 'http://localhost:5173/' })).toBe(false)
  })

  it('checks follow the same rule', () => {
    expect(allowPermissionCheck({ permission: 'media', fromMainWindow: true, mediaType: 'audio', url: 'file:///' })).toBe(true)
    expect(allowPermissionCheck({ permission: 'media', fromMainWindow: true, mediaType: 'video', url: 'file:///' })).toBe(false)
    expect(allowPermissionCheck({ permission: 'media', fromMainWindow: false, mediaType: 'audio', url: 'file:///' })).toBe(false)
  })
})

describe('voice settings', () => {
  it('defaults to off', () => {
    expect(parseVoiceSettings(undefined)).toEqual(DEFAULT_VOICE_SETTINGS)
    expect(DEFAULT_VOICE_SETTINGS.enabled).toBe(false)
  })

  it('keeps valid values and drops unknown keys and wrong types', () => {
    expect(voiceSettingsPatch({ enabled: true, muted: 'yes', sensitivity: 'loud', evil: 1, readAloud: false })).toEqual({ enabled: true, readAloud: false })
    expect(voiceSettingsPatch({ sensitivity: 'higher' })).toEqual({ sensitivity: 'higher' })
  })

  it('round-trips through the data folder and survives a damaged file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'recall-voice-'))
    expect(readVoiceSettings(dir)).toEqual(DEFAULT_VOICE_SETTINGS)
    writeVoiceSettings(dir, { ...DEFAULT_VOICE_SETTINGS, enabled: true, sensitivity: 'lower' })
    expect(readVoiceSettings(dir)).toMatchObject({ enabled: true, sensitivity: 'lower' })
    writeFileSync(path.join(dir, 'voice-settings.json'), '{ broken')
    expect(readVoiceSettings(dir)).toEqual(DEFAULT_VOICE_SETTINGS)
    expect(readFileSync(path.join(dir, 'voice-settings.json'), 'utf8')).toBe('{ broken')
  })

  it('starts with Windows only while voice is on', () => {
    const s = { ...DEFAULT_VOICE_SETTINGS, startWithWindows: true }
    expect(loginItemFor(s).openAtLogin).toBe(false)
    expect(loginItemFor({ ...s, enabled: true })).toEqual({ openAtLogin: true, args: ['--hidden'] })
  })
})

describe('microphone errors', () => {
  it.each([
    ['NotAllowedError', 'MIC_BLOCKED'],
    ['NotReadableError', 'MIC_BLOCKED'],
    ['SecurityError', 'MIC_BLOCKED'],
    ['NotFoundError', 'NO_MIC'],
    ['OverconstrainedError', 'NO_MIC'],
    ['AbortError', 'MIC_FAILED']
  ])('%s → %s', (name, code) => {
    expect(micProblemFromError(name)).toBe(code)
  })
})

describe('tray icon', () => {
  it('encodes a valid PNG at each size', () => {
    for (const size of [16, 24, 32]) {
      const png = encodePng(size, drawTrayIcon(size, 'listening'))
      expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      expect(png.readUInt32BE(16)).toBe(size)
      const idat = png.indexOf('IDAT')
      const len = png.readUInt32BE(idat - 4)
      expect(inflateSync(png.subarray(idat + 4, idat + 4 + len)).length).toBe(size * (size * 4 + 1))
    }
  })

  it('shows a different status dot per state', () => {
    // Bottom-right pixel area holds the dot.
    const at = (state: Parameters<typeof drawTrayIcon>[1]) => Array.from(drawTrayIcon(32, state).subarray((25 * 32 + 25) * 4, (25 * 32 + 25) * 4 + 3))
    expect(at('listening')).not.toEqual(at('muted'))
    expect(at('problem')).not.toEqual(at('listening'))
  })

  it('says the state in words', () => {
    expect(trayTooltip('listening')).toBe('Recall: listening for "Recall"')
    expect(trayTooltip('muted')).toBe('Recall: voice is muted')
  })
})
