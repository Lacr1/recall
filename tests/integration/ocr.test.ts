// S4-06: OCR is opt-in. Off: images are not indexed and no OCR runs. On: text in images and scanned PDFs is
// searchable. The network guard (tests/support/network-guard.ts) fails the test if language data is fetched.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { fakeEmbed } from '../support/fake-embeddings'

vi.mock('../../src/engine/ollama', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/engine/ollama')>()
  return { ...real, embed: async (_model: string, input: string[]) => input.map(fakeEmbed) }
})

const { openDatabase, assertIndexConsistent } = await import('../../src/engine/db')
const { Indexer } = await import('../../src/engine/indexer')
const { SearchService } = await import('../../src/engine/search')
const { VectorIndex } = await import('../../src/engine/vectors')
const { stopOcr } = await import('../../src/engine/ocr')

const require = createRequire(import.meta.url)
const { createCanvas } = require('@napi-rs/canvas') as typeof import('@napi-rs/canvas')

function receiptPng(lines: string[]): Buffer {
  const canvas = createCanvas(1000, 120 + lines.length * 70)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#111111'
  ctx.font = '44px Arial'
  lines.forEach((l, i) => ctx.fillText(l, 50, 90 + i * 70))
  return canvas.toBuffer('image/png')
}

/** A one-page PDF whose only content is a JPEG of the lines: no text layer, like a scanner's output. */
function scannedPdf(lines: string[]): Buffer {
  const canvas = createCanvas(1240, 1754) // A4 at 150 dpi
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#111111'
  ctx.font = '40px Arial'
  lines.forEach((l, i) => ctx.fillText(l, 120, 200 + i * 64))
  const jpeg = canvas.toBuffer('image/jpeg')
  const parts: Buffer[] = []
  const offsets: number[] = []
  let length = 0
  const add = (b: Buffer | string) => {
    const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b
    parts.push(buf)
    length += buf.length
  }
  const obj = (n: number, body: (Buffer | string)[]) => {
    offsets[n] = length
    add(`${n} 0 obj\n`)
    body.forEach(add)
    add('\nendobj\n')
  }
  const content = 'q 595 0 0 842 0 0 cm /Im0 Do Q'
  add('%PDF-1.4\n')
  obj(1, ['<< /Type /Catalog /Pages 2 0 R >>'])
  obj(2, ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>'])
  obj(3, ['<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>'])
  obj(4, [
    `<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
    jpeg,
    '\nendstream'
  ])
  obj(5, [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`])
  const xref = length
  add(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`)
  add(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return Buffer.concat(parts)
}

const TMP_ROOT = path.resolve('tests/.tmp')
let dir: string
let docs: string
let db: ReturnType<typeof openDatabase>
let indexer: InstanceType<typeof Indexer>
let search: InstanceType<typeof SearchService>

const names = (q: string) => search.search(q, undefined).results.map((r) => r.primary.name)
const fileCount = (ext: string) => (db.prepare('SELECT count(*) n FROM files WHERE ext = ?').get(ext) as { n: number }).n

async function settle(timeoutMs = 120_000): Promise<void> {
  const start = Date.now()
  let stableSince = 0
  while (Date.now() - start < timeoutMs) {
    const p = indexer.progress()
    const idle = !p.scanning && p.filesPending === 0 && p.readDone === p.readTotal && p.embedDone === p.embedTotal
    if (idle) {
      stableSince ||= Date.now()
      if (Date.now() - stableSince > 800) return
    } else stableSince = 0
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('Indexing did not settle: ' + JSON.stringify(indexer.progress()))
}

beforeAll(async () => {
  mkdirSync(TMP_ROOT, { recursive: true })
  dir = mkdtempSync(path.join(TMP_ROOT, 'ocr-'))
  docs = path.join(dir, 'docs')
  cpSync(path.resolve('tests/fixtures/corpus'), docs, { recursive: true })
  mkdirSync(path.join(docs, 'receipts'))
  writeFileSync(path.join(docs, 'receipts', 'IMG_2041.png'), receiptPng(['Harbour Kayak Rentals', 'Two person kayak, 3 hours', 'Total paid 84.50 EUR']))
  writeFileSync(
    path.join(docs, 'archive', 'scan-0007.pdf'),
    scannedPdf(['Northwind Plumbing Services', 'Invoice for boiler descaling', 'Amount due within fourteen days'])
  )
  db = openDatabase(path.join(dir, 'recall.db'))
  const vectors = new VectorIndex(db)
  search = new SearchService(db, vectors)
  indexer = new Indexer(db, vectors, () => undefined, () => undefined)
  indexer.setAiReady(true)
  indexer.start()
  indexer.addFolder(docs)
  await settle()
}, 150_000)

afterAll(async () => {
  indexer?.stop()
  await stopOcr()
  db?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('OCR (S4-06)', () => {
  it('is off by default: images are not indexed and scans have no text', () => {
    expect(indexer.ocrEnabled).toBe(false)
    expect(fileCount('png')).toBe(0)
    expect(names('kayak rentals')).toEqual([])
    const failures = indexer.listFailures().map((f) => `${f.name}: ${f.reason}`)
    expect(failures).toContain('scanned-receipt.pdf: No text found (may be a scanned document)')
    expect(failures).toContain('scan-0007.pdf: No text found (may be a scanned document)')
  })

  it('reads text in images and scanned PDFs once turned on', async () => {
    indexer.setOcr(true)
    await settle()
    expect(fileCount('png')).toBe(1)
    expect(names('harbour kayak rentals')[0]).toBe('IMG_2041.png')
    expect(names('84.50')).toContain('IMG_2041.png')
    const failures = indexer.listFailures().map((f) => f.name)
    expect(failures).not.toContain('IMG_2041.png')
    assertIndexConsistent(db)
  }, 150_000)

  it('reads scanned PDFs, page by page', () => {
    expect(names('northwind plumbing boiler descaling')[0]).toBe('scan-0007.pdf')
    const r = search.search('boiler descaling', undefined).results.find((x) => x.primary.name === 'scan-0007.pdf')!
    expect(r.evidence[0].location).toBe('p. 1')
    // The fixture "scan" is a grey box with no words: OCR runs and still finds no text.
    expect(indexer.listFailures().map((f) => f.name)).toContain('scanned-receipt.pdf')
  })

  it('drops images again when turned off', async () => {
    indexer.setOcr(false)
    await settle()
    expect(fileCount('png')).toBe(0)
    expect(names('harbour kayak rentals')).toEqual([])
    assertIndexConsistent(db)
  }, 60_000)
})
