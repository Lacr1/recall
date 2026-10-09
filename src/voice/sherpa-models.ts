// The real speech models behind VoicePipeline, using sherpa-onnx (ADR-0015).
// Every call that returns samples passes enableExternalBuffer = false: Electron's V8 memory cage rejects
// external buffers ("External buffers are not allowed").
import { existsSync } from 'node:fs'
import path from 'node:path'
import { KeywordSpotter, OfflineRecognizer, Vad } from 'sherpa-onnx-node'
import { VOICE_SAMPLE_RATE, type VoiceSensitivity } from '../shared/voice'
import type { SpeechSegmenter, Transcriber, VoiceModels, WakeSpotter } from './pipeline'

const SR = VOICE_SAMPLE_RATE
const VAD_WINDOW = 512

/** Files the voice folder must contain, relative to it. */
export const VOICE_FILES = [
  'keywords.txt',
  'kws/encoder.int8.onnx',
  'kws/decoder.int8.onnx',
  'kws/joiner.int8.onnx',
  'kws/tokens.txt',
  'asr/preprocess.onnx',
  'asr/encode.int8.onnx',
  'asr/uncached_decode.int8.onnx',
  'asr/cached_decode.int8.onnx',
  'asr/tokens.txt',
  'silero_vad.onnx'
]

export function missingVoiceFiles(dir: string): string[] {
  return VOICE_FILES.filter((f) => !existsSync(path.join(dir, f)))
}

// Higher score and lower threshold hear the wake word more easily. "normal" is the S8-01 setting
// (48/48 detected, 0 false wakes on synthetic speech); "lower" and "higher" are tuned on real voices in S8-11.
const SENSITIVITY: Record<VoiceSensitivity, { keywordsScore: number; keywordsThreshold: number }> = {
  lower: { keywordsScore: 1.0, keywordsThreshold: 0.25 },
  normal: { keywordsScore: 1.5, keywordsThreshold: 0.15 },
  higher: { keywordsScore: 2.0, keywordsThreshold: 0.1 }
}

export function createSherpaModels(dir: string): VoiceModels {
  const p = (f: string) => path.join(dir, f)
  const feat = { sampleRate: SR, featureDim: 80 }

  return {
    createSpotter(level): WakeSpotter {
      const kws = new KeywordSpotter({
        featConfig: feat,
        modelConfig: {
          transducer: { encoder: p('kws/encoder.int8.onnx'), decoder: p('kws/decoder.int8.onnx'), joiner: p('kws/joiner.int8.onnx') },
          tokens: p('kws/tokens.txt'),
          numThreads: 1,
          provider: 'cpu',
          debug: 0
        },
        maxActivePaths: 4,
        numTrailingBlanks: 1,
        keywordsFile: p('keywords.txt'),
        ...SENSITIVITY[level]
      })
      const stream = kws.createStream()
      return {
        accept(frame) {
          stream.acceptWaveform({ samples: frame, sampleRate: SR })
          let heard = false
          while (kws.isReady(stream)) {
            kws.decode(stream)
            if (kws.getResult(stream).keyword) {
              heard = true
              kws.reset(stream)
            }
          }
          return heard
        },
        reset: () => kws.reset(stream)
      }
    },

    createSegmenter(): SpeechSegmenter {
      const vad = new Vad(
        {
          sileroVad: { model: p('silero_vad.onnx'), threshold: 0.5, minSilenceDuration: 0.4, minSpeechDuration: 0.25, maxSpeechDuration: 15, windowSize: VAD_WINDOW },
          sampleRate: SR,
          numThreads: 1,
          provider: 'cpu',
          debug: 0
        },
        30
      )
      // Frames are 1600 samples and the VAD takes 512, so the remainder waits for the next frame.
      let rest = new Float32Array(0)
      return {
        accept(frame) {
          const joined = new Float32Array(rest.length + frame.length)
          joined.set(rest)
          joined.set(frame, rest.length)
          let i = 0
          for (; i + VAD_WINDOW <= joined.length; i += VAD_WINDOW) vad.acceptWaveform(joined.subarray(i, i + VAD_WINDOW))
          rest = joined.slice(i)
          const out: Float32Array[] = []
          while (!vad.isEmpty()) {
            out.push(vad.front(false).samples)
            vad.pop()
          }
          return out
        },
        speaking: () => vad.isDetected(),
        reset() {
          vad.reset()
          rest = new Float32Array(0)
        }
      }
    },

    async loadTranscriber(): Promise<Transcriber> {
      const asr = await OfflineRecognizer.createAsync({
        featConfig: feat,
        modelConfig: {
          moonshine: {
            preprocessor: p('asr/preprocess.onnx'),
            encoder: p('asr/encode.int8.onnx'),
            uncachedDecoder: p('asr/uncached_decode.int8.onnx'),
            cachedDecoder: p('asr/cached_decode.int8.onnx')
          },
          tokens: p('asr/tokens.txt'),
          numThreads: 2,
          provider: 'cpu',
          debug: 0
        }
      })
      return {
        transcribe(samples) {
          const s = asr.createStream()
          s.acceptWaveform({ samples, sampleRate: SR })
          asr.decode(s)
          return asr.getResult(s).text
        }
      }
    }
  }
}
