// S0-05: vector search at scale (plan doc 07 §6). Writes eval-results/bench-vectors.md.
// Synthetic unit vectors stand in for embeddings; latency doesn't depend on their content.
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { openDatabase } from '../../src/engine/db'
import { VectorIndex, vecToBuffer } from '../../src/engine/vectors'
import { EMBED_DIMS } from '../../src/shared/constants'

const SIZES = (process.env.BENCH_SIZES ?? '10000,50000,100000,200000').split(',').map(Number)
const QUERIES = 30
const TMP = path.resolve('tests/.tmp')
mkdirSync(TMP, { recursive: true })
const dir = mkdtempSync(path.join(TMP, 'bench-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

// Deterministic PRNG so runs are comparable.
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32 - 0.5
  }
}

function unitVec(rand: () => number): Float32Array {
  const v = new Float32Array(EMBED_DIMS)
  let n = 0
  for (let i = 0; i < EMBED_DIMS; i++) {
    v[i] = rand()
    n += v[i] * v[i]
  }
  n = Math.sqrt(n)
  for (let i = 0; i < EMBED_DIMS; i++) v[i] /= n
  return v
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]
const mb = (b: number) => (b / 1024 / 1024).toFixed(0)

it('measures exact in-memory vector search at scale', async () => {
  const rows: string[] = []
  const rand = rng(42)
  const dbPath = path.join(dir, 'bench.db')
  const db = openDatabase(dbPath)
  db.prepare("INSERT INTO contents(id, sha256, kind, size, created_at) VALUES (1, 'x', 'text', 0, 0)").run()
  const insertChunk = db.prepare("INSERT INTO chunks(id, content_id, ord, text, char_start, char_end) VALUES (?, ?, ?, '', 0, 0)")
  const insertVec = db.prepare('INSERT INTO chunk_vectors(chunk_id, vec) VALUES (?, ?)')
  // Spread chunks over many contents so the content filter is realistic.
  const insertContent = db.prepare("INSERT INTO contents(id, sha256, kind, size, created_at) VALUES (?, ?, 'text', 0, 0)")

  let have = 0
  for (const size of SIZES) {
    const t0 = performance.now()
    db.transaction(() => {
      for (let i = have; i < size; i++) {
        const contentId = 2 + Math.floor(i / 8) // ~8 chunks per document
        if (i % 8 === 0) insertContent.run(contentId, `h${contentId}`)
        insertChunk.run(i + 1, contentId, i % 8)
        insertVec.run(i + 1, vecToBuffer(unitVec(rand)))
      }
    })()
    const insertPerSec = (size - have) / ((performance.now() - t0) / 1000)
    have = size
    db.pragma('wal_checkpoint(TRUNCATE)')
    const dbBytes = statSync(dbPath).size

    global.gc?.()
    const rss0 = process.memoryUsage().rss
    const index = new VectorIndex(db)
    const tl = performance.now()
    expect(index.size).toBe(size) // triggers load
    const loadMs = performance.now() - tl
    const rssDelta = process.memoryUsage().rss - rss0

    const queries = Array.from({ length: QUERIES }, () => unitVec(rand))
    index.search(queries[0], 100) // warm-up (JIT)
    const plain: number[] = []
    for (const q of queries) {
      const t = performance.now()
      const hits = index.search(q, 100)
      plain.push(performance.now() - t)
      expect(hits).toHaveLength(100)
    }
    // Same search with the "live contents" filter the app applies (every content allowed here).
    const live = new Set(Array.from({ length: Math.ceil(size / 8) + 2 }, (_, i) => i))
    const filtered: number[] = []
    for (const q of queries) {
      const t = performance.now()
      index.search(q, 100, (cid) => live.has(cid))
      filtered.push(performance.now() - t)
    }
    rows.push(
      `| ${size.toLocaleString()} | ${pct(plain, 0.5).toFixed(1)} | ${pct(plain, 0.95).toFixed(1)} | ${pct(filtered, 0.95).toFixed(1)} | ${loadMs.toFixed(0)} | ${mb(rssDelta)} | ${mb(dbBytes)} | ${insertPerSec.toFixed(0)} |`
    )
    console.log(rows.at(-1))
    await new Promise((r) => setTimeout(r, 50)) // let the vitest worker answer RPC between sizes
  }
  db.close()

  const report = [
    `# Vector search benchmark (S0-05), ${new Date().toISOString()}`,
    '',
    `Machine: ${os.cpus()[0].model.trim()}, ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB RAM, Node ${process.version}. ${EMBED_DIMS}-dim float32 unit vectors, top-100, ${QUERIES} queries per size.`,
    'Each database row holds an empty chunk text, so the DB size counts vectors and row overhead only (no text or FTS index).',
    '',
    '| Chunks | Search p50 (ms) | Search p95 (ms) | p95 with live-content filter (ms) | Load from DB (ms) | Memory added (MB, RSS) | DB size (MB) | Inserts/s |',
    '|---|---|---|---|---|---|---|---|',
    ...rows
  ].join('\n')
  mkdirSync('eval-results', { recursive: true })
  writeFileSync('eval-results/bench-vectors.md', report)
  console.log('\n' + report)
})
