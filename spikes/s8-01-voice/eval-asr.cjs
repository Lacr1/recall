// Speech-to-text candidates on the 30 request phrases (x2 voices): word error rate, latency, load time, memory.
// Usage: node eval-asr.cjs [whisper-tiny|whisper-base|moonshine-tiny ...]
const path = require('node:path')
const { sherpa, MODELS, SR, manifest, readClip } = require('./common.cjs')

const m = (...p) => path.join(MODELS, ...p)
const CANDIDATES = {
  'whisper-tiny': {
    whisper: { encoder: m('sherpa-onnx-whisper-tiny.en', 'tiny.en-encoder.int8.onnx'), decoder: m('sherpa-onnx-whisper-tiny.en', 'tiny.en-decoder.int8.onnx'), language: 'en', task: 'transcribe', tailPaddings: -1 },
    tokens: m('sherpa-onnx-whisper-tiny.en', 'tiny.en-tokens.txt'),
    files: ['tiny.en-encoder.int8.onnx', 'tiny.en-decoder.int8.onnx', 'tiny.en-tokens.txt'].map((f) => m('sherpa-onnx-whisper-tiny.en', f))
  },
  'whisper-base': {
    whisper: { encoder: m('sherpa-onnx-whisper-base.en', 'base.en-encoder.int8.onnx'), decoder: m('sherpa-onnx-whisper-base.en', 'base.en-decoder.int8.onnx'), language: 'en', task: 'transcribe', tailPaddings: -1 },
    tokens: m('sherpa-onnx-whisper-base.en', 'base.en-tokens.txt'),
    files: ['base.en-encoder.int8.onnx', 'base.en-decoder.int8.onnx', 'base.en-tokens.txt'].map((f) => m('sherpa-onnx-whisper-base.en', f))
  },
  'moonshine-tiny': {
    moonshine: {
      preprocessor: m('sherpa-onnx-moonshine-tiny-en-int8', 'preprocess.onnx'),
      encoder: m('sherpa-onnx-moonshine-tiny-en-int8', 'encode.int8.onnx'),
      uncachedDecoder: m('sherpa-onnx-moonshine-tiny-en-int8', 'uncached_decode.int8.onnx'),
      cachedDecoder: m('sherpa-onnx-moonshine-tiny-en-int8', 'cached_decode.int8.onnx')
    },
    tokens: m('sherpa-onnx-moonshine-tiny-en-int8', 'tokens.txt'),
    files: ['preprocess.onnx', 'encode.int8.onnx', 'uncached_decode.int8.onnx', 'cached_decode.int8.onnx', 'tokens.txt'].map((f) => m('sherpa-onnx-moonshine-tiny-en-int8', f))
  }
}

const words = (s) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').trim().split(/\s+/).filter(Boolean)

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length]
}

const fs = require('node:fs')
const clips = manifest().filter((c) => c.set === 'requests').map((c) => ({ ...c, samples: readClip(c.file) }))
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CANDIDATES)

for (const name of names) {
  const { files, ...model } = CANDIDATES[name]
  const sizeMb = files.reduce((s, f) => s + fs.statSync(f).size, 0) / 1e6
  const rss0 = process.memoryUsage().rss
  const l0 = performance.now()
  const rec = new sherpa.OfflineRecognizer({ featConfig: { sampleRate: SR, featureDim: 80 }, modelConfig: { ...model, numThreads: 2, provider: 'cpu', debug: 0 } })
  const loadMs = performance.now() - l0
  let errors = 0
  let refWords = 0
  let exact = 0
  const lat = []
  const wrong = []
  for (const c of clips) {
    const t0 = performance.now()
    const s = rec.createStream()
    s.acceptWaveform({ samples: c.samples, sampleRate: SR })
    rec.decode(s)
    const text = rec.getResult(s).text
    lat.push(performance.now() - t0)
    const ref = words(c.text)
    const hyp = words(text)
    const e = editDistance(ref, hyp)
    errors += e
    refWords += ref.length
    if (e === 0) exact++
    else wrong.push(`${c.text}  →  ${text.trim()}`)
  }
  lat.sort((a, b) => a - b)
  const audioSec = clips.reduce((s, c) => s + c.samples.length / SR, 0) / clips.length
  console.log(
    JSON.stringify(
      {
        model: name,
        sizeMb: +sizeMb.toFixed(1),
        loadMs: Math.round(loadMs),
        rssAddedMb: Math.round((process.memoryUsage().rss - rss0) / 1e6),
        wer: +(errors / refWords).toFixed(3),
        exactMatch: `${exact}/${clips.length}`,
        avgClipSec: +audioSec.toFixed(2),
        latencyMs: { p50: Math.round(lat[Math.floor(lat.length / 2)]), p95: Math.round(lat[Math.floor(lat.length * 0.95)]) },
        wrong
      },
      null,
      1
    )
  )
}
