const path = require('node:path')
const sherpa = require('sherpa-onnx-node')
const R = path.join(process.resourcesPath, 'voice')
const SR = 16000
const kwsFile = path.join(require('node:os').tmpdir(), 'voice-spike-kw.txt')
require('node:fs').writeFileSync(kwsFile, '▁RE CA LL :1.0 #0.15 @RECALL\n▁RE C AL L :1.0 #0.15 @RECALL\n')
const kws = new sherpa.KeywordSpotter({ featConfig: { sampleRate: SR, featureDim: 80 }, modelConfig: { transducer: { encoder: path.join(R, 'kws', 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'), decoder: path.join(R, 'kws', 'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'), joiner: path.join(R, 'kws', 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx') }, tokens: path.join(R, 'kws', 'tokens.txt'), numThreads: 1, provider: 'cpu', debug: 0 }, keywordsFile: kwsFile })
const a = (f) => path.join(R, 'asr', f)
const asr = new sherpa.OfflineRecognizer({ featConfig: { sampleRate: SR, featureDim: 80 }, modelConfig: { moonshine: { preprocessor: a('preprocess.onnx'), encoder: a('encode.int8.onnx'), uncachedDecoder: a('uncached_decode.int8.onnx'), cachedDecoder: a('cached_decode.int8.onnx') }, tokens: a('tokens.txt'), numThreads: 2, provider: 'cpu', debug: 0 } })
const vad = new sherpa.Vad({ sileroVad: { model: path.join(R, 'silero_vad.onnx'), threshold: 0.5, minSilenceDuration: 0.4, minSpeechDuration: 0.25, windowSize: 512 }, sampleRate: SR, numThreads: 1, provider: 'cpu', debug: 0 }, 30)
const wave = sherpa.readWave(path.join(R, 'test.wav'), false)
const padded = new Float32Array(wave.samples.length + SR)
padded.set(wave.samples)
const st = kws.createStream()
st.acceptWaveform({ samples: padded, sampleRate: SR })
let wake = false
while (kws.isReady(st)) { kws.decode(st); if (kws.getResult(st).keyword) { wake = true; kws.reset(st) } }
for (let i = 0; i + 512 <= padded.length; i += 512) vad.acceptWaveform(padded.subarray(i, i + 512))
vad.flush()
const texts = []
while (!vad.isEmpty()) { const seg = vad.front(false); vad.pop(); const s = asr.createStream(); s.acceptWaveform({ samples: seg.samples, sampleRate: SR }); asr.decode(s); texts.push(asr.getResult(s).text.trim()) }
process.parentPort.postMessage({ wake, texts, addon: require.resolve('sherpa-onnx-node') })
setTimeout(() => process.exit(0), 1000)
