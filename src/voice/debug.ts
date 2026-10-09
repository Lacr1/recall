// Dev-only voice diagnostics for tuning the wake word on real voices (plan 12 S8-11). Enabled by
// RECALL_VOICE_DEBUG=<folder>, which main passes on only in unpackaged builds, so a shipped Recall never records.
// Saves what the microphone delivered to <folder>/session.wav (first 5 minutes) and logs to <folder>/debug.log,
// for each utterance, what speech-to-text heard and whether the wake word fired.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { VOICE_SAMPLE_RATE } from '../shared/voice'
import type { Transcriber, VoiceModels } from './pipeline'

const MAX_SEC = 300
const LEVEL_EVERY_FRAMES = 50

export function withDebug(models: VoiceModels, dir: string): VoiceModels {
  mkdirSync(dir, { recursive: true })
  const pcm = new Int16Array(VOICE_SAMPLE_RATE * MAX_SEC)
  let n = 0
  let frames = 0
  let peak = 0
  let transcriber: Promise<Transcriber> | undefined
  const sec = () => n / VOICE_SAMPLE_RATE
  // Also written to a file: a utility process's console output doesn't always reach the terminal on Windows.
  const log = (msg: string) => {
    const line = `[voice-debug ${sec().toFixed(1)}s] ${msg}`
    console.log(line)
    appendFileSync(path.join(dir, 'debug.log'), line + '\n')
  }
  const save = () => writeFileSync(path.join(dir, 'session.wav'), pcm16Wav(pcm.subarray(0, n)))

  return {
    createSpotter(level) {
      const spotter = models.createSpotter(level)
      log(`wake-word spotter ready (sensitivity ${level})`)
      return {
        accept(frame) {
          for (let i = 0; i < frame.length; i++) {
            peak = Math.max(peak, Math.abs(frame[i]))
            if (n < pcm.length) pcm[n++] = Math.max(-32768, Math.min(32767, Math.round(frame[i] * 32768)))
          }
          if (++frames % LEVEL_EVERY_FRAMES === 0) {
            log(`mic peak over last 5 s: ${peak.toFixed(3)}`)
            peak = 0
            save()
          }
          const heard = spotter.accept(frame)
          if (heard) log('WAKE WORD HEARD')
          return heard
        },
        reset: () => spotter.reset()
      }
    },

    createSegmenter() {
      const segmenter = models.createSegmenter()
      return {
        accept(frame) {
          const out = segmenter.accept(frame)
          for (const seg of out) {
            const end = sec()
            const start = end - seg.length / VOICE_SAMPLE_RATE
            let top = 0
            for (let i = 0; i < seg.length; i++) top = Math.max(top, Math.abs(seg[i]))
            transcriber ??= models.loadTranscriber()
            void transcriber.then((t) => log(`utterance ${start.toFixed(1)}–${end.toFixed(1)}s, peak ${top.toFixed(3)}: "${t.transcribe(seg).trim()}"`))
            save()
          }
          return out
        },
        speaking: () => segmenter.speaking(),
        reset: () => segmenter.reset()
      }
    },

    loadTranscriber: () => models.loadTranscriber()
  }
}

function pcm16Wav(samples: Int16Array): Buffer {
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + samples.byteLength, 4)
  head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(VOICE_SAMPLE_RATE, 24)
  head.writeUInt32LE(VOICE_SAMPLE_RATE * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(samples.byteLength, 40)
  return Buffer.concat([head, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)])
}
