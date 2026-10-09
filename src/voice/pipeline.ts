// Wake word → end of speech → speech-to-text, independent of the speech library so it can be tested with fakes.
// Rules found in the S8-01 spike (docs/validation/s8-01-voice-spike.md):
// - The keyword stream is reset at every pause; a never-reset stream drifted and missed 4 in 10 wake words.
//   The reset waits RESET_DELAY_FRAMES after the pause, because the spotter decides about 0.6 s after the word
//   while the pause detector closes a segment after 0.4 s; resetting at once could drop a pending wake word.
// - Speech-to-text loads on the wake word (or a lone word that may be a missed one) and unloads when idle,
//   keeping idle listening at about 130 MB.
import { VOICE_FRAME_SAMPLES, VOICE_SAMPLE_RATE, type VoiceCommand, type VoiceEvent, type VoiceSensitivity } from '../shared/voice'
import { isHeardWakeWordAlone, stripHeardWakeWord } from '../shared/wake-word'

export interface WakeSpotter {
  /** Feeds one frame; true when the wake word was heard in it. */
  accept(frame: Float32Array): boolean
  reset(): void
}

export interface SpeechSegmenter {
  /** Feeds one frame; returns the utterances that ended in it. */
  accept(frame: Float32Array): Float32Array[]
  /** True while speech is in progress. */
  speaking(): boolean
  reset(): void
}

export interface Transcriber {
  transcribe(samples: Float32Array): string
}

export interface VoiceModels {
  createSpotter(level: VoiceSensitivity): WakeSpotter
  createSegmenter(): SpeechSegmenter
  loadTranscriber(): Promise<Transcriber>
}

/** How long after the wake word an utterance is transcribed without being asked. */
export const WAKE_WINDOW_MS = 8000
export const TRANSCRIBER_IDLE_MS = 120_000
export const RESET_DELAY_FRAMES = 8
/**
 * An utterance waits this long after it ends before it is sent on, because the spotter can report the wake word
 * up to about 0.3 s after the pause detector has closed the utterance that holds it. Without the wait, "Recall"
 * on its own was transcribed ("We call.") and handled as a request.
 */
export const WAKE_SETTLE_FRAMES = 5
/** Speech the pause detector keeps after the last word: it closes an utterance after 0.4 s of silence. */
const TRAILING_SILENCE_SAMPLES = 0.4 * VOICE_SAMPLE_RATE
/**
 * Second chance: a lone word this long that the spotter let pass is checked with speech-to-text, and opens the
 * prompt if it was "Recall". On real voices the spotter caught 6 of 11; with this, 9 of 11 (S8-11).
 */
export const LONE_WORD_MIN_SAMPLES = 0.3 * VOICE_SAMPLE_RATE
export const LONE_WORD_MAX_SAMPLES = 1.5 * VOICE_SAMPLE_RATE

export function isValidFrame(x: unknown): x is Float32Array {
  if (!(x instanceof Float32Array) || x.length !== VOICE_FRAME_SAMPLES) return false
  for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) return false
  return true
}


export class VoicePipeline {
  private listening = false
  private ignoring = false
  private meter = false
  private sensitivity: VoiceSensitivity = 'normal'
  private spotter: WakeSpotter
  private segmenter: SpeechSegmenter
  private transcribeUntil = 0
  private resetIn = 0
  // Positions in samples heard since listening started.
  private heard = 0
  private wakeAt = -Infinity
  private pending: { samples: Float32Array; start: number; end: number }[] = []
  private transcriber?: Promise<Transcriber>
  private idleTimer?: ReturnType<typeof setTimeout>
  // Utterances are transcribed one at a time, in the order they were heard.
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly models: VoiceModels,
    private readonly emit: (e: VoiceEvent) => void,
    private readonly now: () => number = Date.now
  ) {
    this.spotter = models.createSpotter(this.sensitivity)
    this.segmenter = models.createSegmenter()
  }

  command(c: VoiceCommand): void {
    switch (c.type) {
      case 'setListening':
        this.listening = c.on
        if (!c.on) this.clear()
        break
      case 'ignoreAudio':
        this.ignoring = c.on
        // Whatever was half-heard while Recall spoke is its own voice: drop it.
        if (c.on) this.clear()
        break
      case 'expectUtterance':
        this.transcribeUntil = this.now() + Math.max(0, Math.min(c.ms, 30_000))
        this.warmTranscriber()
        break
      case 'setSensitivity':
        if (c.level !== this.sensitivity) {
          this.sensitivity = c.level
          this.spotter = this.models.createSpotter(c.level)
        }
        break
      case 'levelMeter':
        this.meter = c.on
        break
    }
  }

  /** Frames that aren't exactly one valid 100 ms block are dropped, whatever sent them. */
  frame(x: unknown): void {
    if (!this.listening || this.ignoring || !isValidFrame(x)) return
    if (this.meter) this.emit({ event: 'level', rms: rms(x) })
    this.heard += x.length
    if (this.spotter.accept(x)) {
      this.wakeAt = this.heard
      this.emit({ event: 'wake' })
      this.transcribeUntil = this.now() + WAKE_WINDOW_MS
      this.warmTranscriber()
    }
    // Skipped if the next utterance has already begun: its own end schedules another reset.
    if (this.resetIn > 0 && --this.resetIn === 0 && !this.segmenter.speaking()) this.spotter.reset()
    for (const samples of this.segmenter.accept(x)) {
      this.resetIn = RESET_DELAY_FRAMES
      const end = this.heard
      this.pending.push({ samples, start: end - TRAILING_SILENCE_SAMPLES - samples.length, end })
    }
    const settled = this.heard - WAKE_SETTLE_FRAMES * VOICE_FRAME_SAMPLES
    while (this.pending.length && (this.pending[0].end <= settled || this.wakeAt >= this.pending[0].start)) {
      const u = this.pending.shift()!
      const withWake = this.wakeAt >= u.start
      if (this.now() <= this.transcribeUntil) this.enqueue(u.samples, withWake)
      else if (!withWake && this.sensitivity !== 'lower' && u.samples.length >= LONE_WORD_MIN_SAMPLES && u.samples.length <= LONE_WORD_MAX_SAMPLES)
        this.checkMissedWake(u.samples)
    }
  }

  /** Resolves when every utterance heard so far has been transcribed (used by tests and the smoke run). */
  idle(): Promise<void> {
    return this.queue
  }

  /** `withWake`: the wake word was heard inside this utterance, so its transcript starts with it, often misheard. */
  private enqueue(segment: Float32Array, withWake: boolean): void {
    this.queue = this.queue.then(async () => {
      let text: string
      try {
        text = (await this.loadTranscriber()).transcribe(segment).trim()
      } catch {
        this.transcriber = undefined
        this.emit({ event: 'problem', code: 'TRANSCRIBE_FAILED' })
        return
      }
      this.scheduleUnload()
      if (!text) return
      // "Recall" said again while the prompt is open holds the wake word too, even if the spotter missed it.
      const wake = withWake || isHeardWakeWordAlone(text)
      // Close the window once the request has been heard; main reopens it when it needs another answer. After
      // only the wake word ("Recall." or misheard, "We call."), the request is still to come.
      if (!wake || stripHeardWakeWord(text)) this.transcribeUntil = 0
      this.emit({ event: 'utterance', text, sec: Math.round((segment.length / VOICE_SAMPLE_RATE) * 100) / 100, wake })
    })
  }

  /** Speech-to-text loads for this as for a wake word, and unloads after the same idle time. */
  private checkMissedWake(segment: Float32Array): void {
    this.queue = this.queue.then(async () => {
      let text: string
      try {
        text = (await this.loadTranscriber()).transcribe(segment)
      } catch {
        // Only a second chance: a failure here is not worth a problem report.
        this.transcriber = undefined
        return
      }
      this.scheduleUnload()
      if (!this.listening || this.ignoring || !isHeardWakeWordAlone(text)) return
      this.emit({ event: 'wake' })
      this.transcribeUntil = this.now() + WAKE_WINDOW_MS
    })
  }

  private loadTranscriber(): Promise<Transcriber> {
    this.transcriber ??= this.models.loadTranscriber()
    return this.transcriber
  }

  /** Starts loading on the wake word: the ~0.7 s load overlaps with the user still speaking. */
  private warmTranscriber(): void {
    this.loadTranscriber().catch(() => {
      this.transcriber = undefined
    })
    this.scheduleUnload()
  }

  private scheduleUnload(): void {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.transcriber = undefined
    }, TRANSCRIBER_IDLE_MS)
  }

  private clear(): void {
    this.transcribeUntil = 0
    this.resetIn = 0
    this.pending = []
    this.wakeAt = -Infinity
    this.spotter.reset()
    this.segmenter.reset()
  }
}

function rms(x: Float32Array): number {
  let s = 0
  for (let i = 0; i < x.length; i++) s += x[i] * x[i]
  return Math.sqrt(s / x.length)
}
