// utilityProcess side of the spike: loads KWS + VAD + Moonshine, takes 16 kHz Float32 frames over parentPort,
// and reports wake detections and transcripts. Mirrors the planned src/voice pipeline in miniature.
const path = require('node:path')
const t0 = performance.now()
const { sherpa, MODELS, SR, createSpotter } = require('../common.cjs')

const kws = createSpotter({ score: 1.0, threshold: 0.15 })
let kwsStream = kws.createStream()
const vad = new sherpa.Vad({ sileroVad: { model: path.join(MODELS, 'silero_vad.onnx'), threshold: 0.5, minSilenceDuration: 0.4, minSpeechDuration: 0.25, windowSize: 512 }, sampleRate: SR, numThreads: 1, provider: 'cpu', debug: 0 }, 30)
const mm = (f) => path.join(MODELS, 'sherpa-onnx-moonshine-tiny-en-int8', f)
const asr = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: SR, featureDim: 80 },
  modelConfig: { moonshine: { preprocessor: mm('preprocess.onnx'), encoder: mm('encode.int8.onnx'), uncachedDecoder: mm('uncached_decode.int8.onnx'), cachedDecoder: mm('cached_decode.int8.onnx') }, tokens: mm('tokens.txt'), numThreads: 2, provider: 'cpu', debug: 0 }
})
const post = (m) => process.parentPort.postMessage(m)
post({ event: 'loaded', ms: Math.round(performance.now() - t0), rssMb: Math.round(process.memoryUsage().rss / 1e6) })

let pending = new Float32Array(0)
let frames = 0
process.parentPort.on('message', (e) => {
  if (e.data.type === 'port' && e.ports[0]) {
    // Audio from the renderer arrives on its own port, never through main's IPC handlers.
    e.ports[0].on('message', (ev) => onMessage(ev.data))
    e.ports[0].start()
    return
  }
  onMessage(e.data)
})

function onMessage(msg) {
  if (msg.type === 'rss') return post({ event: 'rss', rssMb: Math.round(process.memoryUsage().rss / 1e6), frames })
  if (msg.type !== 'frame' || !(msg.samples instanceof Float32Array)) return
  frames++
  kwsStream.acceptWaveform({ samples: msg.samples, sampleRate: SR })
  while (kws.isReady(kwsStream)) {
    kws.decode(kwsStream)
    if (kws.getResult(kwsStream).keyword) {
      post({ event: 'wake', atFrame: frames })
      kws.reset(kwsStream)
    }
  }
  // VAD needs 512-sample windows.
  const joined = new Float32Array(pending.length + msg.samples.length)
  joined.set(pending)
  joined.set(msg.samples, pending.length)
  let i = 0
  for (; i + 512 <= joined.length; i += 512) vad.acceptWaveform(joined.subarray(i, i + 512))
  pending = joined.slice(i)
  while (!vad.isEmpty()) {
    const seg = vad.front(false)
    vad.pop()
    const s = asr.createStream()
    s.acceptWaveform({ samples: seg.samples, sampleRate: SR })
    const a0 = performance.now()
    asr.decode(s)
    post({ event: 'utterance', text: asr.getResult(s).text.trim(), sec: +(seg.samples.length / SR).toFixed(2), asrMs: Math.round(performance.now() - a0) })
    kws.reset(kwsStream)
  }
}
