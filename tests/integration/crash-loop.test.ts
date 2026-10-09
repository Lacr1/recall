import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync,
  type Dirent
} from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertIndexConsistent, openDatabase } from '../../src/engine/db'
import { FakeOllama } from '../support/fake-ollama'

// Plan S1-08 crash loop: the indexer runs as a child process and is killed at seeded random points while it works.
// After every kill the database must be consistent; at the end it must match a clean index of the same files.
const SEED = Number(process.env.CRASH_SEED ?? 20261009)
const KILLS = 20
const MAX_RUNS = 60

const CORPUS = path.resolve('tests/fixtures/corpus')
const TMP_ROOT = path.resolve('tests/.tmp')

let dir: string
let harness: string
const ollama = new FakeOllama()

interface Done {
  cacheSize: number
  stored: number
}

interface Kill {
  /** Indexing step after which to kill (1 = after the first step). */
  step: number
  /** Extra delay after that step, so some kills land inside the next step rather than between steps. */
  delayMs: number
}

beforeAll(async () => {
  mkdirSync(TMP_ROOT, { recursive: true })
  dir = mkdtempSync(path.join(TMP_ROOT, 'crash-'))
  harness = path.join(dir, 'harness.mjs')
  await build({
    entryPoints: ['tests/support/crash-harness.ts'],
    outfile: harness,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['better-sqlite3', 'pdfjs-dist', 'mammoth'],
    logLevel: 'error'
  })
  await ollama.start()
})

afterAll(async () => {
  await ollama.stop()
  rmSync(dir, { recursive: true, force: true })
})

/** Runs the harness, optionally killing it mid-work. Resolves with the summary if it finished on its own. */
function runHarness(dbPath: string, folder: string, kill?: Kill): Promise<{ killed: boolean; done?: Done; steps: number }> {
  const child = spawn(process.execPath, [harness, dbPath, folder], {
    env: { ...process.env, RECALL_OLLAMA_URL: ollama.url },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  let err = ''
  let steps = 0
  let timer: NodeJS.Timeout | undefined
  child.stdout.on('data', (d: Buffer) => {
    const text = d.toString()
    out += text
    steps += text.split('\n').filter((l) => l === 'T').length
    // On Windows kill() terminates the process at once, like a crash: no exit handlers run.
    if (kill && !timer && steps >= kill.step) timer = setTimeout(() => child.kill(), kill.delayMs)
  })
  child.stderr.on('data', (d) => (err += d))
  return new Promise((resolve, reject) => {
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      const line = out.split('\n').find((l) => l.startsWith('DONE '))
      if (line) return resolve({ killed: false, done: JSON.parse(line.slice(5)) as Done, steps })
      if (signal || (kill && code !== 0)) return resolve({ killed: true, steps })
      reject(new Error(`harness exited with code ${code}: ${err.slice(-2000)}`))
    })
  })
}

const KEYWORDS = ['payment', 'authentication', 'warranty', 'booking', 'invoices', 'lasagna']

/**
 * Everything search depends on, independent of row ids: each file's status and content, a fingerprint of that
 * content's passages and exact vectors, and every file each keyword matches (full lists, so no ranking ties).
 */
function snapshot(dbPath: string): unknown {
  const db = openDatabase(dbPath)
  try {
    const chunks = db.prepare(
      `SELECT ch.ord, ch.text, ch.char_start, ch.char_end, ch.page_start, ch.page_end, ch.section_path, v.vec
       FROM chunks ch LEFT JOIN chunk_vectors v ON v.chunk_id = ch.id WHERE ch.content_id = ? ORDER BY ch.ord`
    )
    const fingerprint = (contentId: number | null) => {
      if (contentId === null) return null
      const h = createHash('sha256')
      for (const c of chunks.all(contentId) as Record<string, unknown>[]) {
        const { vec, ...rest } = c
        h.update(JSON.stringify(rest)).update((vec as Buffer | null) ?? 'no vector')
      }
      return h.digest('hex')
    }
    const files = (db
      .prepare(
        `SELECT x.rel_path, x.status, x.content_id, c.sha256, c.extract_status, c.embed_status, c.chunk_count, c.title, c.page_count
         FROM files x LEFT JOIN contents c ON c.id = x.content_id ORDER BY x.rel_path`
      )
      .all() as ({ content_id: number | null } & Record<string, unknown>)[]).map(({ content_id, ...f }) => ({ ...f, passages: fingerprint(content_id) }))
    const matches = (table: string, joinOn: string, word: string) =>
      (db
        .prepare(`SELECT DISTINCT x.rel_path p FROM ${table} JOIN ${joinOn} WHERE ${table} MATCH ? ORDER BY p`)
        .all(word) as { p: string }[]).map((r) => r.p)
    const keyword = KEYWORDS.map((w) =>
      matches('chunks_fts', "chunks ch ON ch.id = chunks_fts.rowid JOIN files x ON x.content_id = ch.content_id AND x.status = 'linked'", w)
    )
    const names = ['acme', 'proposal', 'note'].map((w) => matches('files_fts', 'files x ON x.id = files_fts.rowid', w))
    return { files, keyword, names }
  } finally {
    db.close()
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function listFiles(root: string): string[] {
  return (readdirSync(root, { recursive: true, withFileTypes: true }) as Dirent[])
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name))
    .sort()
}

/** Changes the folder between crashes so restarts also exercise re-extraction, renames, deletes, duplicates and GC. */
function mutate(root: string, rand: () => number, i: number): string {
  // Always some new text to read and embed, so the next run has work to be killed in.
  const paragraphs = Array.from({ length: 6 }, (_, p) => `Note ${i}, part ${p}: follow up on the booking system and invoices. `.repeat(12))
  writeFileSync(path.join(root, 'notes', `note-${i}.md`), `# Note ${i}\n\n` + paragraphs.join('\n\n'))

  const r = rand()
  const files = listFiles(root)
  const pick = (list: string[]) => list[Math.floor(rand() * list.length)]
  if (r < 0.3) return 'new note'
  if (r < 0.5) {
    const f = pick(files.filter((x) => /\.(md|txt)$/.test(x)))
    appendFileSync(f, `\nEdit ${i}: added a line about the quarterly review.\n`)
    return 'new note, edit ' + path.basename(f)
  }
  if (r < 0.65) {
    const f = pick(files)
    renameSync(f, path.join(path.dirname(f), `renamed-${i}-${path.basename(f)}`))
    return 'new note, rename ' + path.basename(f)
  }
  if (r < 0.8) {
    const f = pick(files)
    unlinkSync(f)
    return 'new note, delete ' + path.basename(f)
  }
  if (r < 0.9) {
    const f = pick(files)
    copyFileSync(f, path.join(path.dirname(f), `copy-${i}${path.extname(f)}`))
    return 'new note, copy ' + path.basename(f)
  }
  const f = pick(files)
  const t = new Date(Date.now() - 1000 * 60 * 60 * 24 * (i + 1))
  utimesSync(f, t, t)
  return 'new note, touch ' + path.basename(f)
}

it(`stays consistent when the indexer is killed ${KILLS} times (seed ${SEED})`, async () => {
  const work = path.join(dir, 'work')
  const docs = path.join(work, 'docs')
  const dbPath = path.join(work, 'recall.db')
  cpSync(CORPUS, docs, { recursive: true, preserveTimestamps: true })
  const rand = mulberry32(SEED)
  const log: string[] = []
  let kills = 0
  // Kill points are drawn from the steps the last uninterrupted run needed (a full first index needs about 100).
  let lastSteps = 100
  for (let i = 0; kills < KILLS; i++) {
    if (i >= MAX_RUNS) throw new Error(`only ${kills} kills in ${MAX_RUNS} runs\n${log.join('\n')}`)
    const kill = { step: 1 + Math.floor(rand() * lastSteps), delayMs: Math.floor(rand() * 30) }
    const res = await runHarness(dbPath, docs, kill)
    if (res.killed) kills++
    else lastSteps = res.steps
    // Opening the database recovers the WAL exactly as the app would on its next start.
    const db = openDatabase(dbPath)
    try {
      assertIndexConsistent(db)
    } catch (err) {
      throw new Error(`run ${i} (seed ${SEED}, step ${kill.step} + ${kill.delayMs} ms): ${(err as Error).message}\n${log.join('\n')}`)
    } finally {
      db.close()
    }
    const outcome = res.killed ? `killed after ${res.steps} steps` : `finished first (${res.steps} steps)`
    log.push(`${i}: kill at step ${kill.step} + ${kill.delayMs} ms: ${outcome}; then ${mutate(docs, rand, i)}`)
  }
  console.log(log.join('\n'))

  // Let it finish. Old versions of changed files wait 10 minutes before cleanup and still count in keyword
  // statistics, so age them past that grace period and run once more before comparing.
  await runHarness(dbPath, docs)
  const db = openDatabase(dbPath)
  db.prepare('UPDATE contents SET orphaned_at = 1 WHERE NOT EXISTS (SELECT 1 FROM files WHERE content_id = contents.id)').run()
  db.close()
  const final = await runHarness(dbPath, docs)
  const db2 = openDatabase(dbPath)
  expect(db2.prepare('SELECT count(*) n FROM contents WHERE orphaned_at IS NOT NULL').get()).toEqual({ n: 0 })
  db2.close()

  // Then index the same final files from scratch and compare.
  const ref = path.join(dir, 'reference')
  cpSync(docs, path.join(ref, 'docs'), { recursive: true, preserveTimestamps: true })
  const clean = await runHarness(path.join(ref, 'recall.db'), path.join(ref, 'docs'))

  expect(final.done!.cacheSize).toBe(final.done!.stored)
  expect(clean.done!.cacheSize).toBe(clean.done!.stored)
  expect(snapshot(dbPath)).toEqual(snapshot(path.join(ref, 'recall.db')))
}, 300_000)
