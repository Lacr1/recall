// Shared helpers for the S8-01 spike scripts. Spike code only; never imported by src/.
const fs = require('node:fs')
const path = require('node:path')
const sherpa = require('sherpa-onnx-node')

const ROOT = __dirname
const MODELS = path.join(ROOT, 'models')
const AUDIO = path.join(ROOT, 'audio')
// Two candidate keyword models: the small KWS model (GigaSpeech, non-commercial training data) and a
// LibriSpeech-trained streaming model (CC BY 4.0 data). Pick with KWS_MODEL=gigaspeech|librispeech.
const KWS_MODELS = {
  gigaspeech: { dir: 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01', stem: '-epoch-12-avg-2-chunk-16-left-64', tokens: ['▁RE CA LL', '▁RE C AL L', '▁RE CA L L'] },
  librispeech: { dir: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17', stem: '-epoch-99-avg-1', tokens: ['▁RE C AL L', '▁RE C A LL'] }
}
const KWS = KWS_MODELS[process.env.KWS_MODEL || 'gigaspeech']
const KWS_DIR = path.join(MODELS, KWS.dir)
const SR = 16000

// "recall" is not one BPE piece in either vocabulary, so it is listed in the likely splits.
const RECALL_TOKENS = KWS.tokens

function keywordsFile(score, threshold) {
  const file = path.join(ROOT, `.keywords-${process.env.KWS_MODEL || 'gigaspeech'}-${score}-${threshold}.txt`)
  const lines = RECALL_TOKENS.map((t) => `${t} :${score} #${threshold} @RECALL`)
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return file
}

function createSpotter({ score = 1.5, threshold = 0.25, numThreads = 1, int8 = true } = {}) {
  const suffix = int8 ? '.int8.onnx' : '.onnx'
  return new sherpa.KeywordSpotter({
    featConfig: { sampleRate: SR, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(KWS_DIR, 'encoder' + KWS.stem + suffix),
        decoder: path.join(KWS_DIR, 'decoder' + KWS.stem + suffix),
        joiner: path.join(KWS_DIR, 'joiner' + KWS.stem + suffix)
      },
      tokens: path.join(KWS_DIR, 'tokens.txt'),
      numThreads,
      provider: 'cpu',
      debug: 0
    },
    maxActivePaths: 4,
    numTrailingBlanks: 1,
    keywordsFile: keywordsFile(score, threshold)
  })
}

function manifest() {
  const raw = fs.readFileSync(path.join(AUDIO, 'manifest.json'), 'utf8').replace(/^﻿/, '')
  return JSON.parse(raw)
}

function readClip(rel) {
  // Electron's V8 memory cage rejects external buffers, so the samples are copied into a normal one.
  return sherpa.readWave(path.join(AUDIO, rel), false).samples
}

/** Feeds samples in 100 ms frames, as the app will, and returns detection times in seconds. */
function spot(kws, stream, samples, offsetSec, out) {
  const frame = SR / 10
  for (let i = 0; i < samples.length; i += frame) {
    stream.acceptWaveform({ samples: samples.subarray(i, i + frame), sampleRate: SR })
    while (kws.isReady(stream)) {
      kws.decode(stream)
      const r = kws.getResult(stream)
      if (r.keyword) {
        out.push(offsetSec + i / SR)
        kws.reset(stream)
      }
    }
  }
}

module.exports = { sherpa, ROOT, MODELS, AUDIO, SR, createSpotter, manifest, readClip, spot }
