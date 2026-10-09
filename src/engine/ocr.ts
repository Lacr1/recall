import { createRequire } from 'node:module'
import path from 'node:path'
import type { Worker } from 'tesseract.js'

// Plan S4-06 / decision D-06: optional OCR with tesseract.js and English data bundled with the app, so
// nothing is downloaded at runtime (the engine's network guard would block it anyway). Off by default; with it
// off, no image is read and no worker is started.

const req = createRequire(import.meta.url)

let workerPromise: Promise<Worker> | undefined
let idleTimer: NodeJS.Timeout | undefined
const IDLE_MS = 60_000

/** Integer LSTM model: about 3 MB, close to "best" accuracy at a fraction of the size. */
function langPath(): string {
  return path.join(path.dirname(req.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int')
}

async function worker(): Promise<Worker> {
  clearTimeout(idleTimer)
  workerPromise ??= (async () => {
    const { createWorker, OEM } = await import('tesseract.js')
    return createWorker('eng', OEM.LSTM_ONLY, {
      langPath: langPath(),
      gzip: true,
      cacheMethod: 'none', // never write language data elsewhere
      logger: () => undefined,
      errorHandler: () => undefined
    })
  })().catch((err) => {
    workerPromise = undefined
    throw err
  })
  return workerPromise
}

/** The worker holds ~100 MB; it is ended after a minute without OCR work. */
function scheduleIdleStop(): void {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => void stopOcr(), IDLE_MS)
  idleTimer.unref()
}

export async function stopOcr(): Promise<void> {
  clearTimeout(idleTimer)
  const p = workerPromise
  workerPromise = undefined
  if (p) await (await p).terminate().catch(() => undefined)
}

/** Text in an image (PNG, JPEG, BMP, TIFF, WebP), one OCR pass. Low-confidence words are kept: search ranks them. */
export async function recognize(image: Buffer): Promise<string> {
  const w = await worker()
  try {
    const { data } = await w.recognize(image)
    return data.text ?? ''
  } finally {
    scheduleIdleStop()
  }
}
