// Voice settings live in the data folder as voice-settings.json, owned by main: main needs them at startup
// (tray, close behaviour, login item) before the engine is up. "Delete all data" removes the file, which turns
// voice off (FR-VOICE-17).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_VOICE_SETTINGS, type VoiceSensitivity, type VoiceSettings } from '../../shared/voice'

const FILE = 'voice-settings.json'
const SENSITIVITIES: readonly VoiceSensitivity[] = ['lower', 'normal', 'higher']
const BOOLEAN_KEYS = ['enabled', 'readAloud', 'startWithWindows', 'muted'] as const

/** Keeps only known keys with the right types; anything else falls back to the default. */
export function parseVoiceSettings(raw: unknown): VoiceSettings {
  const out = { ...DEFAULT_VOICE_SETTINGS }
  if (!raw || typeof raw !== 'object') return out
  return { ...out, ...voiceSettingsPatch(raw as Record<string, unknown>) }
}

/** A validated partial update from the renderer. Unknown keys and wrong types are dropped. */
export function voiceSettingsPatch(p: Record<string, unknown>): Partial<VoiceSettings> {
  const patch: Partial<VoiceSettings> = {}
  for (const k of BOOLEAN_KEYS) if (typeof p[k] === 'boolean') patch[k] = p[k]
  if (SENSITIVITIES.includes(p.sensitivity as VoiceSensitivity)) patch.sensitivity = p.sensitivity as VoiceSensitivity
  return patch
}

export function readVoiceSettings(dataDir: string): VoiceSettings {
  try {
    return parseVoiceSettings(JSON.parse(readFileSync(path.join(dataDir, FILE), 'utf8')))
  } catch {
    return { ...DEFAULT_VOICE_SETTINGS }
  }
}

export function writeVoiceSettings(dataDir: string, s: VoiceSettings): void {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(path.join(dataDir, FILE), JSON.stringify(s, null, 2))
}

/** Start with Windows only makes sense while voice is on; Recall then starts hidden in the tray. */
export function loginItemFor(s: VoiceSettings): { openAtLogin: boolean; args: string[] } {
  return { openAtLogin: s.enabled && s.startWithWindows, args: ['--hidden'] }
}
