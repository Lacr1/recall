// S4-07 (plan doc 04 §5.5, 05 §4.7): switching the embedding model builds a new space in the background,
// search keeps working on the old one, the swap is atomic, and the old vectors are removed.
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { fakeEmbed } from '../support/fake-embeddings'

// A second "model" with 384 dimensions that is slow, and can't embed anything mentioning lasagna.
const MINI_DIMS = 384
const miniEmbed = (text: string) => {
  const v = fakeEmbed('mini ' + text).slice(0, MINI_DIMS)
  const n = Math.hypot(...v) || 1
  return v.map((x) => x / n)
}
const calls = { mini: 0 }

vi.mock('../../src/engine/ollama', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/engine/ollama')>()
  return {
    ...real,
    embed: async (model: string, input: string[]) => {
      if (model !== 'fake-mini') return input.map(fakeEmbed)
      calls.mini++
      await new Promise((r) => setTimeout(r, 40))
      if (input.some((t) => /lasagna/i.test(t))) throw new real.OllamaError('context_exceeded')
      return input.map(miniEmbed)
    }
  }
})

const { openDatabase, assertIndexConsistent } = await import('../../src/engine/db')
const { Indexer } = await import('../../src/engine/indexer')
const { SearchService } = await import('../../src/engine/search')
const { VectorIndex, toUnitVec } = await import('../../src/engine/vectors')
const { activeSpace, buildingSpace, cancelBuild, startBuild } = await import('../../src/engine/spaces')

const TMP_ROOT = path.resolve('tests/.tmp')
let dir: string
let db: ReturnType<typeof openDatabase>
let indexer: InstanceType<typeof Indexer>
let vectors: InstanceType<typeof VectorIndex>
let search: InstanceType<typeof SearchService>
let activations = 0

const count = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n
const until = async (cond: () => boolean, ms = 45_000) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out: ' + JSON.stringify(indexer.progress()))
    await new Promise((r) => setTimeout(r, 50))
  }
}
const idle = () => {
  const p = indexer.progress()
  return !p.scanning && p.filesPending === 0 && p.readDone === p.readTotal && p.embedDone === p.embedTotal
}
const nomicQuery = (q: string) => toUnitVec(fakeEmbed('search_query: ' + q))
const miniQuery = (q: string) => toUnitVec(miniEmbed(q))

beforeAll(async () => {
  mkdirSync(TMP_ROOT, { recursive: true })
  dir = mkdtempSync(path.join(TMP_ROOT, 'model-'))
  cpSync(path.resolve('tests/fixtures/corpus'), path.join(dir, 'docs'), { recursive: true })
  db = openDatabase(path.join(dir, 'recall.db'))
  vectors = new VectorIndex(db)
  search = new SearchService(db, vectors)
  indexer = new Indexer(db, vectors, () => undefined, () => undefined)
  indexer.onSpaceActivated = () => activations++
  indexer.setAiReady(true)
  indexer.start()
  indexer.addFolder(path.join(dir, 'docs'))
  await until(idle)
})

afterAll(() => {
  indexer?.stop()
  db?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('changing the embedding model', () => {
  it('starts with nomic-embed-text as the active space', () => {
    expect(activeSpace(db)).toMatchObject({ id: 1, model: 'nomic-embed-text', dims: 768, status: 'active' })
    expect(count('SELECT count(*) n FROM chunk_vectors WHERE space_id = 1')).toBeGreaterThan(0)
    assertIndexConsistent(db)
  })

  it('cancelling a change drops the partial space and keeps the active one', async () => {
    startBuild(db, 'fake-mini', 'digest-a')
    indexer.wakeLanes()
    await until(() => calls.mini > 0)
    expect(cancelBuild(db)).toBe(true)
    expect(buildingSpace(db)).toBeUndefined()
    await new Promise((r) => setTimeout(r, 200)) // a batch in flight must not resurrect it
    expect(count('SELECT count(*) n FROM chunk_vectors WHERE space_id <> 1')).toBe(0)
    expect(activeSpace(db).model).toBe('nomic-embed-text')
    assertIndexConsistent(db)
  })

  it('keeps searching on the old model while the new one builds, then swaps atomically', async () => {
    const before = search.search('dishwasher warranty', nomicQuery('dishwasher warranty')).results.map((r) => r.primary.name)
    expect(before[0]).toBe('Dishwasher_DW-450_Manual.pdf')

    const space = startBuild(db, 'fake-mini', 'digest-b')
    expect(space).toMatchObject({ model: 'fake-mini', status: 'building', docPrefix: '', queryPrefix: '', lowConfidenceCosine: null })
    indexer.wakeLanes()
    await until(() => (indexer.buildProgress()?.done ?? 0) > 0)
    // Mid-build: the active space and its search are untouched.
    expect(activeSpace(db).model).toBe('nomic-embed-text')
    expect(search.search('dishwasher warranty', nomicQuery('dishwasher warranty')).results.map((r) => r.primary.name)).toEqual(before)

    await until(() => !buildingSpace(db))
    expect(activations).toBe(1)
    expect(activeSpace(db)).toMatchObject({ id: space.id, model: 'fake-mini', dims: MINI_DIMS, status: 'active' })
    expect(count('SELECT count(*) n FROM embedding_spaces')).toBe(1)
    expect(count('SELECT count(*) n FROM chunk_vectors WHERE space_id <> ?', space.id)).toBe(0)
    expect(vectors.activeSpaceId).toBe(space.id)
    assertIndexConsistent(db)

    const after = search.search('dishwasher warranty', miniQuery('dishwasher warranty')).results.map((r) => r.primary.name)
    expect(after).toContain('Dishwasher_DW-450_Manual.pdf')
    // Uncalibrated model: no low-confidence flag rather than a guessed threshold.
    expect(search.search('my passport renewal', miniQuery('my passport renewal')).lowConfidence).toBe(false)
  })

  it('marks files the new model could not embed as failed, still keyword-searchable', () => {
    const failures = indexer.listFailures().map((f) => `${f.name}: ${f.reason}`)
    expect(failures).toContain('lasagna.md: Meaning index failed (keyword search still works)')
    expect(search.search('lasagna bechamel', undefined).results.map((r) => r.primary.name)).toContain('lasagna.md')
  })

  it('embeds new files into the new space', async () => {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(path.join(dir, 'docs', 'notes', 'kayak.txt'), 'Kayak rental contract renewal notes for the summer season.')
    indexer.rescanFolder(1)
    await until(() => count("SELECT count(*) n FROM files WHERE name = 'kayak.txt' AND status = 'linked'") === 1)
    await until(idle)
    expect(search.search('kayak rental', miniQuery('kayak rental')).results[0].primary.name).toBe('kayak.txt')
    assertIndexConsistent(db)
  })
})
