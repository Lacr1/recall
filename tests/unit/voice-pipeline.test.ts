// VoicePipeline rules with fake models (plan 12 S8-02): frame validation, wake window, delayed keyword reset,
// on-demand speech-to-text with idle unload, ignoring audio while Recall speaks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isValidFrame, RESET_DELAY_FRAMES, TRANSCRIBER_IDLE_MS, VoicePipeline, WAKE_SETTLE_FRAMES, WAKE_WINDOW_MS, type VoiceModels } from '../../src/voice/pipeline'
import { VOICE_FRAME_SAMPLES, type VoiceEvent } from '../../src/shared/voice'
import { readPcm16Wav, toFrames } from '../../src/shared/wav'

// Frame markers the fakes react to: sample[0] = 1 → wake word; 2 → an utterance ends here; 3 → a lone word ends.
const frame = (marker = 0) => {
  const f = new Float32Array(VOICE_FRAME_SAMPLES)
  f[0] = marker
  return f
}
const WAKE = 1
const END = 2
const WORD = 3

function fakes(transcripts: string[] = ['find my resume']) {
  const calls = { spotterResets: 0, segmenterResets: 0, loads: 0, spotters: [] as string[] }
  let speaking = false
  const models: VoiceModels = {
    createSpotter(level) {
      calls.spotters.push(level)
      return { accept: (f) => f[0] === WAKE, reset: () => void calls.spotterResets++ }
    },
    createSegmenter() {
      return {
        // A sentence (2 s), or a lone word (0.6 s).
        accept: (f) => (f[0] === END ? [new Float32Array(32000)] : f[0] === WORD ? [new Float32Array(9600)] : []),
        speaking: () => speaking,
        reset: () => void calls.segmenterResets++
      }
    },
    async loadTranscriber() {
      calls.loads++
      let i = 0
      return { transcribe: () => transcripts[Math.min(i++, transcripts.length - 1)] }
    }
  }
  return { models, calls, setSpeaking: (v: boolean) => (speaking = v) }
}

let now = 0
let events: VoiceEvent[]
const make = (transcripts?: string[]) => {
  const f = fakes(transcripts)
  const p = new VoicePipeline(f.models, (e) => events.push(e), () => now)
  p.command({ type: 'setListening', on: true })
  return { p, ...f }
}
const utterances = () => events.filter((e) => e.event === 'utterance').map((e) => (e as { text: string }).text)

beforeEach(() => {
  now = 1_000_000
  events = []
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('frames', () => {
  it('accepts only 1600-sample finite Float32Arrays', () => {
    expect(isValidFrame(frame())).toBe(true)
    expect(isValidFrame(new Float32Array(1599))).toBe(false)
    expect(isValidFrame(new Float64Array(1600))).toBe(false)
    expect(isValidFrame([...frame()])).toBe(false)
    expect(isValidFrame('audio')).toBe(false)
    const bad = frame()
    bad[10] = NaN
    expect(isValidFrame(bad)).toBe(false)
  })

  it('drops invalid frames without reacting', () => {
    const { p } = make()
    const big = new Float32Array(3200)
    big[0] = WAKE
    p.frame(big)
    expect(events).toEqual([])
  })

  it('ignores everything until listening is on', () => {
    const { p } = make()
    p.command({ type: 'setListening', on: false })
    p.frame(frame(WAKE))
    expect(events).toEqual([])
  })
})

describe('wake word and utterances', () => {
  it('emits wake and transcribes the next utterance, then closes the window', async () => {
    const { p, calls } = make(['find my resume', 'something else'])
    p.frame(frame(WAKE))
    expect(events[0]).toEqual({ event: 'wake' })
    p.frame(frame(END))
    await p.idle()
    expect(utterances()).toEqual(['find my resume'])
    p.frame(frame(END))
    await p.idle()
    expect(utterances()).toEqual(['find my resume'])
    expect(calls.loads).toBe(1)
  })

  it('keeps the window open when the utterance is only the wake word', async () => {
    const { p } = make(['Recall.', 'find my resume'])
    p.frame(frame(WAKE))
    p.frame(frame(END))
    await p.idle()
    p.frame(frame(END))
    await p.idle()
    expect(utterances()).toEqual(['Recall.', 'find my resume'])
  })

  it('does not transcribe speech without a wake word', async () => {
    const { p, calls } = make()
    p.frame(frame(END))
    await p.idle()
    expect(utterances()).toEqual([])
    expect(calls.loads).toBe(0)
  })

  it('stops transcribing when the wake window runs out', async () => {
    const { p } = make()
    p.frame(frame(WAKE))
    now += WAKE_WINDOW_MS + 1
    p.frame(frame(END))
    await p.idle()
    expect(utterances()).toEqual([])
  })

  it('expectUtterance reopens the window for an answer', async () => {
    const { p } = make(['yes', 'find my resume'])
    p.frame(frame(WAKE))
    p.frame(frame(END))
    await p.idle()
    p.command({ type: 'expectUtterance', ms: 8000 })
    p.frame(frame(END))
    await p.idle()
    expect(utterances()).toEqual(['yes', 'find my resume'])
  })

  it('skips empty transcripts', async () => {
    const { p } = make(['  '])
    p.frame(frame(WAKE))
    p.frame(frame(END))
    await p.idle()
    expect(utterances()).toEqual([])
  })

  const silence = (p: VoicePipeline, n: number) => {
    for (let i = 0; i < n; i++) p.frame(frame())
  }
  const wakeFlags = () => events.filter((e) => e.event === 'utterance').map((e) => (e as { wake: boolean }).wake)

  it('marks an utterance holding the wake word, even when the spotter reports it after the utterance closed', async () => {
    // Real voices: "Recall" alone was transcribed "We call." and the spotter fired 0.2 s after the pause closed it.
    const { p } = make(['We call.', 'find my resume'])
    p.frame(frame(WAKE))
    silence(p, 30)
    p.frame(frame(END))
    p.frame(frame(WAKE))
    await p.idle()
    expect(utterances()).toEqual(['We call.'])
    expect(wakeFlags()).toEqual([true])
    // Only the wake word, misheard: the request is still to come.
    silence(p, 30)
    p.frame(frame(END))
    silence(p, WAKE_SETTLE_FRAMES)
    await p.idle()
    expect(utterances()).toEqual(['We call.', 'find my resume'])
    expect(wakeFlags()).toEqual([true, false])
  })

  it('holds an utterance without the wake word until the spotter has had time to report it', async () => {
    const { p } = make(['find my resume'])
    p.frame(frame(WAKE))
    silence(p, 30)
    p.frame(frame(END))
    silence(p, WAKE_SETTLE_FRAMES - 1)
    await p.idle()
    expect(utterances()).toEqual([])
    p.frame(frame())
    await p.idle()
    expect(utterances()).toEqual(['find my resume'])
    expect(wakeFlags()).toEqual([false])
  })

  it('second chance: a lone word heard as "Recall" opens the prompt when the spotter missed it', async () => {
    const { p } = make(['We call.', 'find my resume'])
    silence(p, 30)
    p.frame(frame(WORD))
    silence(p, WAKE_SETTLE_FRAMES)
    await p.idle()
    expect(events.map((e) => e.event)).toEqual(['wake'])
    // The window is open for the request, like after a wake word.
    silence(p, 10)
    p.frame(frame(END))
    silence(p, WAKE_SETTLE_FRAMES)
    await p.idle()
    expect(utterances()).toEqual(['find my resume'])
  })

  it('second chance ignores other lone words, sentences, and the Lower sensitivity', async () => {
    const other = make(['Okay.'])
    silence(other.p, 30)
    other.p.frame(frame(WORD))
    silence(other.p, WAKE_SETTLE_FRAMES)
    await other.p.idle()
    expect(events).toEqual([])
    expect(other.calls.loads).toBe(1)

    const sentence = make(['We call.'])
    silence(sentence.p, 30)
    sentence.p.frame(frame(END))
    silence(sentence.p, WAKE_SETTLE_FRAMES)
    await sentence.p.idle()
    expect(sentence.calls.loads).toBe(0)

    const lower = make(['We call.'])
    lower.p.command({ type: 'setSensitivity', level: 'lower' })
    silence(lower.p, 30)
    lower.p.frame(frame(WORD))
    silence(lower.p, WAKE_SETTLE_FRAMES)
    await lower.p.idle()
    expect(lower.calls.loads).toBe(0)
    expect(events).toEqual([])
  })

  it('marks a lone "We call." heard while the prompt is open as the wake word, and keeps listening', async () => {
    const { p } = make(['Recall.', 'We call.', 'find my resume'])
    p.frame(frame(WAKE))
    p.frame(frame(END))
    for (let i = 0; i < 2; i++) {
      silence(p, 40)
      p.frame(frame(END))
      silence(p, WAKE_SETTLE_FRAMES)
    }
    await p.idle()
    expect(utterances()).toEqual(['Recall.', 'We call.', 'find my resume'])
    expect(wakeFlags()).toEqual([true, true, false])
  })

  it('closes the window after the wake word and a request in one breath', async () => {
    const { p } = make(['We call, find my resume.', 'something else'])
    p.frame(frame(WAKE))
    p.frame(frame(END))
    await p.idle()
    expect(wakeFlags()).toEqual([true])
    silence(p, 30)
    p.frame(frame(END))
    silence(p, WAKE_SETTLE_FRAMES)
    await p.idle()
    expect(utterances()).toEqual(['We call, find my resume.'])
  })
})

describe('keyword stream reset', () => {
  it('resets the spotter a few frames after a pause, not at once', () => {
    const { p, calls } = make()
    p.frame(frame(END))
    const before = calls.spotterResets
    for (let i = 0; i < RESET_DELAY_FRAMES - 1; i++) p.frame(frame())
    expect(calls.spotterResets).toBe(before)
    p.frame(frame())
    expect(calls.spotterResets).toBe(before + 1)
  })

  it('skips the reset when the next utterance has already started', () => {
    const { p, calls, setSpeaking } = make()
    p.frame(frame(END))
    const before = calls.spotterResets
    setSpeaking(true)
    for (let i = 0; i < RESET_DELAY_FRAMES + 2; i++) p.frame(frame())
    expect(calls.spotterResets).toBe(before)
  })
})

describe('speech-to-text loading', () => {
  it('starts loading on the wake word and unloads after being idle', async () => {
    const { p, calls } = make()
    p.frame(frame(WAKE))
    expect(calls.loads).toBe(1)
    p.frame(frame(END))
    await p.idle()
    vi.advanceTimersByTime(TRANSCRIBER_IDLE_MS + 1)
    p.frame(frame(WAKE))
    expect(calls.loads).toBe(2)
  })

  it('reports a problem when the model cannot load, and tries again next time', async () => {
    const f = fakes()
    let fail = true
    f.models.loadTranscriber = async () => {
      f.calls.loads++
      if (fail) throw new Error('broken')
      return { transcribe: () => 'find my resume' }
    }
    const p = new VoicePipeline(f.models, (e) => events.push(e), () => now)
    p.command({ type: 'setListening', on: true })
    p.frame(frame(WAKE))
    p.frame(frame(END))
    await p.idle()
    expect(events).toContainEqual({ event: 'problem', code: 'TRANSCRIBE_FAILED' })
    fail = false
    p.frame(frame(WAKE))
    p.frame(frame(END))
    await p.idle()
    expect(utterances()).toEqual(['find my resume'])
  })
})

describe('commands', () => {
  it('ignores audio while Recall speaks and drops what was half-heard', async () => {
    const { p, calls } = make()
    p.frame(frame(WAKE))
    p.command({ type: 'ignoreAudio', on: true })
    expect(calls.segmenterResets).toBe(1)
    p.frame(frame(WAKE))
    p.frame(frame(END))
    await p.idle()
    expect(events.filter((e) => e.event === 'wake')).toHaveLength(1)
    expect(utterances()).toEqual([])
  })

  it('recreates the spotter only when the sensitivity changes', () => {
    const { p, calls } = make()
    p.command({ type: 'setSensitivity', level: 'normal' })
    p.command({ type: 'setSensitivity', level: 'higher' })
    expect(calls.spotters).toEqual(['normal', 'higher'])
  })

  it('emits mic levels only while the meter is on', () => {
    const { p } = make()
    p.frame(frame())
    p.command({ type: 'levelMeter', on: true })
    const loud = new Float32Array(VOICE_FRAME_SAMPLES).fill(0.5)
    p.frame(loud)
    expect(events).toEqual([{ event: 'level', rms: 0.5 }])
  })
})

describe('wav', () => {
  it('reads 16-bit mono PCM and splits it into padded frames', () => {
    const n = 2000
    const buf = new Uint8Array(44 + n * 2)
    const v = new DataView(buf.buffer)
    const put = (at: number, s: string) => [...s].forEach((c, i) => (buf[at + i] = c.charCodeAt(0)))
    put(0, 'RIFF')
    v.setUint32(4, 36 + n * 2, true)
    put(8, 'WAVE')
    put(12, 'fmt ')
    v.setUint32(16, 16, true)
    v.setUint16(20, 1, true)
    v.setUint16(22, 1, true)
    v.setUint32(24, 16000, true)
    v.setUint32(28, 32000, true)
    v.setUint16(32, 2, true)
    v.setUint16(34, 16, true)
    put(36, 'data')
    v.setUint32(40, n * 2, true)
    v.setInt16(44, -32768, true)
    v.setInt16(46, 16384, true)
    const wav = readPcm16Wav(buf)
    expect(wav.sampleRate).toBe(16000)
    expect(wav.samples.length).toBe(n)
    expect(wav.samples[0]).toBe(-1)
    expect(wav.samples[1]).toBe(0.5)
    const frames = toFrames(wav.samples, VOICE_FRAME_SAMPLES)
    expect(frames).toHaveLength(2)
    expect(frames[1].length).toBe(VOICE_FRAME_SAMPLES)
  })

  it('rejects stereo or non-WAV input', () => {
    expect(() => readPcm16Wav(new TextEncoder().encode('not a wav file at all'))).toThrow('Not a WAV file')
  })
})
