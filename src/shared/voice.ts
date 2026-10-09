// Messages between main and the voice utilityProcess (plan 12 §6.1, ADR-0015).
// Audio frames never use these: they arrive on their own MessagePort as bare Float32Arrays.

export const VOICE_SAMPLE_RATE = 16000
/** 100 ms of 16 kHz mono audio. The voice process drops any frame of another size. */
export const VOICE_FRAME_SAMPLES = 1600

export type VoiceSensitivity = 'lower' | 'normal' | 'higher'

export type VoiceCommand =
  | { type: 'setListening'; on: boolean }
  /** While Recall is speaking, so it doesn't hear itself. */
  | { type: 'ignoreAudio'; on: boolean }
  /** Transcribe the next utterance heard within `ms` (after "yes", or for a follow-up). */
  | { type: 'expectUtterance'; ms: number }
  | { type: 'setSensitivity'; level: VoiceSensitivity }
  /** Emit `level` events, for the mic meter in onboarding and Settings. */
  | { type: 'levelMeter'; on: boolean }
  | { type: 'shutdown' }

export type VoiceProblemCode = 'MODELS_MISSING' | 'MODELS_DAMAGED' | 'TRANSCRIBE_FAILED' | 'VOICE_CRASHED'

export type VoiceEvent =
  | { event: 'ready'; loadMs: number }
  | { event: 'wake' }
  /** `wake`: the wake word was heard inside this utterance, so the text starts with it, often misheard. */
  | { event: 'utterance'; text: string; sec: number; wake: boolean }
  | { event: 'level'; rms: number }
  | { event: 'problem'; code: VoiceProblemCode }

export interface VoiceSettings {
  enabled: boolean
  readAloud: boolean
  startWithWindows: boolean
  muted: boolean
  sensitivity: VoiceSensitivity
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enabled: false,
  readAloud: true,
  startWithWindows: false,
  muted: false,
  sensitivity: 'normal'
}

/** Problems the renderer reports while opening the microphone. */
export type MicProblemCode = 'MIC_BLOCKED' | 'NO_MIC' | 'MIC_LOST' | 'MIC_FAILED'
export const MIC_PROBLEM_CODES: readonly MicProblemCode[] = ['MIC_BLOCKED', 'NO_MIC', 'MIC_LOST', 'MIC_FAILED']

export type VoiceState = 'off' | 'starting' | 'listening' | 'muted' | 'problem'

export interface VoiceStatus {
  state: VoiceState
  problem?: VoiceProblemCode | MicProblemCode
  settings: VoiceSettings
}

/** Maps a getUserMedia error name to what the user is told (plan 12 FR-VOICE-15). */
export function micProblemFromError(name: string): MicProblemCode {
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
    // Windows reports a mic blocked in Privacy settings, or held by another app, as "not readable".
    case 'NotReadableError':
      return 'MIC_BLOCKED'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'NO_MIC'
    default:
      return 'MIC_FAILED'
  }
}
