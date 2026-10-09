// Developer setup: puts the pinned voice model files in resources/voice/ (git-ignored), where dev runs and
// electron-builder pick them up. The app itself never downloads anything (plan 12 D-17, ADR-0013).
// Usage: node scripts/fetch-voice-models.mjs [--from=<folder with the extracted model folders>]
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const OUT = path.resolve('resources/voice')
const RELEASES = 'https://github.com/k2-fsa/sherpa-onnx/releases/download'
const KWS = 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17'
const ASR = 'sherpa-onnx-moonshine-tiny-en-int8'

// [source folder, source file, destination, sha256]
const FILES = [
  [KWS, 'encoder-epoch-99-avg-1.int8.onnx', 'kws/encoder.int8.onnx', '3810755ce7c3ab26b42a8bcf39d191308fa27fb0f53358823ba46141d03b7eb3'],
  [KWS, 'decoder-epoch-99-avg-1.int8.onnx', 'kws/decoder.int8.onnx', '21e2a2acd961b3ac72f55be2f10f1a285e1b0b0ba010d7c0b6eab141411b163c'],
  [KWS, 'joiner-epoch-99-avg-1.int8.onnx', 'kws/joiner.int8.onnx', 'e085d73b593cf9b0707f370dbd656d58327d3fe36d80d849202ef81df02cb01e'],
  [KWS, 'tokens.txt', 'kws/tokens.txt', '49e3c2646595fd907228b3c6787069658f67b17377c60aeb8619c4551b2316fb'],
  [ASR, 'preprocess.onnx', 'asr/preprocess.onnx', 'f33addce61a143460fe753b5ee5b7db255e5140b5b779c065b94f6c83ff0bf4e'],
  [ASR, 'encode.int8.onnx', 'asr/encode.int8.onnx', '8774dfba578de027ec6595c2c654a0836434489bc963a0db124a7f181f571acb'],
  [ASR, 'uncached_decode.int8.onnx', 'asr/uncached_decode.int8.onnx', '216737000dd5881a17aa043f6bbd286add33e4c3b0ae257153e2ec15438bdc41'],
  [ASR, 'cached_decode.int8.onnx', 'asr/cached_decode.int8.onnx', '2aff28bba6a03d8dcf5c9feac45462629bae37317442299f28115ad09da773f6'],
  [ASR, 'tokens.txt', 'asr/tokens.txt', '1165c2aeb9f72f457a83be2d459a09054f27490acd9b41bd43794dfd25e296ea'],
  [ASR, 'LICENSE', 'asr/LICENSE', '29f60769d1779eb7e196d96b8d2dd471d0263cf8200c79e55c0c00183971ee1b'],
  ['', 'silero_vad.onnx', 'silero_vad.onnx', '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6']
]

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

async function download(url, file) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  writeFileSync(file, Buffer.from(await res.arrayBuffer()))
}

const from = process.argv.find((a) => a.startsWith('--from='))?.slice('--from='.length)
let source = from && path.resolve(from)
let temp
if (!source) {
  temp = mkdtempSync(path.join(tmpdir(), 'recall-voice-'))
  source = temp
  for (const archive of [`asr-models/${KWS}.tar.bz2`, `asr-models/${ASR}.tar.bz2`]) {
    const file = path.join(temp, path.basename(archive))
    console.log('downloading', archive)
    await download(`${RELEASES}/${archive}`, file)
    const tar = spawnSync('tar', ['-xjf', file, '-C', temp], { stdio: 'inherit' })
    if (tar.status !== 0) throw new Error('could not extract ' + archive)
  }
  console.log('downloading silero_vad.onnx')
  await download(`${RELEASES}/asr-models/silero_vad.onnx`, path.join(temp, 'silero_vad.onnx'))
}

let failed = false
for (const [dir, name, dest, hash] of FILES) {
  const src = path.join(source, dir, name)
  const out = path.join(OUT, dest)
  if (!existsSync(src)) {
    console.error('missing', src)
    failed = true
    continue
  }
  mkdirSync(path.dirname(out), { recursive: true })
  copyFileSync(src, out)
  const got = sha256(out)
  if (got !== hash) {
    console.error(`checksum mismatch for ${dest}: ${got}`)
    rmSync(out)
    failed = true
  } else console.log('ok', dest)
}
if (temp) rmSync(temp, { recursive: true, force: true })
if (failed) process.exit(1)
