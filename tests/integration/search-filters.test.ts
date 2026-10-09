// Stage 4 search (S4-01 filters, S4-02 newest-first and date words, S4-05 passages in the document view)
// on the fixture corpus, with fake embeddings so meaning search runs too.
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { fakeEmbed } from '../support/fake-embeddings'
import type { SearchFilters } from '../../src/shared/types'

vi.mock('../../src/engine/ollama', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/engine/ollama')>()
  return { ...real, embed: async (_model: string, input: string[]) => input.map(fakeEmbed) }
})

const { openDatabase } = await import('../../src/engine/db')
const { Indexer } = await import('../../src/engine/indexer')
const { SearchService } = await import('../../src/engine/search')
const { VectorIndex, toUnitVec } = await import('../../src/engine/vectors')
const { readDocument } = await import('../../src/engine/documents')
const { interpretQuery } = await import('../../src/engine/temporal')

const CORPUS = path.resolve('tests/fixtures/corpus')
const TMP_ROOT = path.resolve('tests/.tmp')

let dir: string
let db: ReturnType<typeof openDatabase>
let indexer: InstanceType<typeof Indexer>
let search: InstanceType<typeof SearchService>
const folderIds: Record<string, number> = {}

const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12)
// The three Acme versions were written a month apart; everything else is older.
const MTIMES: Record<string, Date> = {
  'clients/acme/Acme_Proposal_v1.docx': at(2026, 1, 12),
  'clients/acme/Acme_Proposal_v2.pdf': at(2026, 2, 16),
  'clients/acme/Acme_Proposal_v3.docx': at(2026, 3, 9),
  'Downloads/Acme_Proposal_v3 (1).docx': at(2026, 3, 9)
}

function setTimes(root: string, rel = ''): void {
  for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) setTimes(root, r)
    else {
      const t = MTIMES[r] ?? at(2025, 6, 1)
      utimesSync(path.join(root, r), t, t)
    }
  }
}

async function settle(timeoutMs = 45_000): Promise<void> {
  const start = Date.now()
  let stableSince = 0
  while (Date.now() - start < timeoutMs) {
    const p = indexer.progress()
    const idle = !p.scanning && p.filesPending === 0 && p.readDone === p.readTotal && p.embedDone === p.embedTotal
    if (idle) {
      stableSince ||= Date.now()
      if (Date.now() - stableSince > 600) return
    } else stableSince = 0
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('Indexing did not settle: ' + JSON.stringify(indexer.progress()))
}

/** What the engine service does: take out time words, then search with the filters. */
function query(q: string, filters: SearchFilters = {}) {
  const { query: rest, opts } = interpretQuery(q, filters)
  const vec = rest.trim() ? toUnitVec(fakeEmbed('search_query: ' + rest)) : undefined
  return search.search(rest, vec, opts)
}
const names = (q: string, filters?: SearchFilters) => query(q, filters).results.map((r) => r.primary.name)
/** Every file a search shows: each result's file, its copies and its other versions. */
const allNames = (q: string, filters?: SearchFilters) =>
  query(q, filters).results.flatMap((r) => [r.primary, ...r.copies, ...r.versions].map((f) => f.name))

beforeAll(async () => {
  mkdirSync(TMP_ROOT, { recursive: true })
  dir = mkdtempSync(path.join(TMP_ROOT, 'filters-'))
  const root = path.join(dir, 'files')
  cpSync(CORPUS, root, { recursive: true })
  setTimes(root)
  db = openDatabase(path.join(dir, 'recall.db'))
  const vectors = new VectorIndex(db)
  search = new SearchService(db, vectors)
  indexer = new Indexer(db, vectors, () => undefined, () => undefined)
  indexer.setAiReady(true)
  indexer.start()
  // Each top-level folder is its own Recall folder, so the folder filter has something to choose between.
  for (const name of readdirSync(root)) folderIds[name] = indexer.addFolder(path.join(root, name)).id
  await settle()
})

afterAll(() => {
  indexer?.stop()
  db?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('filters (S4-01)', () => {
  it('limits every list to the chosen type', () => {
    const all = allNames('payment proposal warranty')
    expect(all.some((n) => n.endsWith('.docx'))).toBe(true)
    const pdfs = allNames('payment proposal warranty', { type: 'pdf' })
    expect(pdfs.length).toBeGreaterThan(0)
    expect(pdfs.every((n) => n.endsWith('.pdf'))).toBe(true)
    // The file-name list too: "acme" matches the DOCX names, which the filter must drop.
    expect(names('acme', { type: 'pdf' })).toEqual(['Acme_Proposal_v2.pdf'])
    expect(names('authentication session', { type: 'code' })).toContain('session.ts')
    expect(names('authentication session', { type: 'notes' })).not.toContain('session.ts')
  })

  it('limits results to one folder and lists only that folder’s copies', () => {
    const inClients = query('acme proposal', { folderId: folderIds.clients }).results
    expect(inClients.length).toBeGreaterThan(0)
    expect(inClients.every((r) => [r.primary, ...r.copies].every((f) => f.folderPath.endsWith('clients')))).toBe(true)
    const v3 = query('acme proposal', { folderId: folderIds.Downloads }).results
    expect(v3.map((r) => r.primary.name)).toEqual(['Acme_Proposal_v3 (1).docx'])
    expect(v3[0].copies).toEqual([])
  })

  it('limits results to a modified-date range', () => {
    const feb = { from: +at(2026, 2, 1), to: +at(2026, 3, 1), label: 'February 2026' }
    expect(names('acme proposal payment', { modified: feb })).toEqual(['Acme_Proposal_v2.pdf'])
  })

  it('combines filters', () => {
    expect(allNames('acme proposal', { type: 'docx', folderId: folderIds.clients }).sort()).toEqual(['Acme_Proposal_v1.docx', 'Acme_Proposal_v3.docx'])
    expect(names('acme proposal', { type: 'code', folderId: folderIds.clients })).toEqual([])
  })
})

describe('time words (S4-02)', () => {
  it('ranks the newest version first for "latest"', () => {
    const r = query('latest acme proposal').results
    expect(r[0].primary.name).toMatch(/^Acme_Proposal_v3/)
    expect(r[0].reasons.map((x) => x.kind)).toContain('newest')
  })

  it('turns a month in the query into a date filter', () => {
    expect(names('acme proposal from February 2026')).toEqual(['Acme_Proposal_v2.pdf'])
    // The user removed the chip: the words are searched as typed and nothing is filtered by date.
    expect(names('acme proposal from February 2026', { ignoreTemporal: true }).length).toBeGreaterThan(1)
  })

  it('a date filter the user picked wins over the query’s date words', () => {
    const jan = { from: +at(2026, 1, 1), to: +at(2026, 2, 1), label: 'January 2026' }
    expect(names('acme proposal from February 2026', { modified: jan })).toEqual(['Acme_Proposal_v1.docx'])
  })

  it('lists matching files newest first when only time words or filters are given', () => {
    const r = query('newest', { folderId: folderIds.clients }).results
    expect(r[0].primary.name).toBe('Acme_Proposal_v3.docx')
    expect(r.map((x) => x.primary.mtimeMs)).toEqual([...r.map((x) => x.primary.mtimeMs)].sort((a, b) => b - a))
    expect(r[0].reasons[0]).toEqual({ kind: 'filters' })
    // Both copies of v3 are one result; either may be the primary, as they have the same modified time.
    const march = query('files from March 2026').results
    expect(march).toHaveLength(1)
    expect([march[0].primary, ...march[0].copies].map((f) => f.name).sort()).toEqual(['Acme_Proposal_v3 (1).docx', 'Acme_Proposal_v3.docx'])
  })
})

describe('versions (S4-04)', () => {
  it('shows the Acme proposal versions as one result, led by the best match', () => {
    const r = query('proposal with a 50% initial payment').results
    const acme = r.filter((x) => [x.primary, ...x.versions].some((f) => f.name.startsWith('Acme_Proposal')))
    expect(acme).toHaveLength(1)
    expect(acme[0].primary.name).toBe('Acme_Proposal_v2.pdf')
    // Newest first; the v3 result's copy in Downloads is the same content, so it is a copy, not a version.
    expect(acme[0].versions.map((v) => v.name)).toEqual([expect.stringMatching(/^Acme_Proposal_v3/), 'Acme_Proposal_v1.docx'])
    expect(acme[0].reasons).toContainEqual({ kind: 'versions', count: 3, newest: false })
  })

  it('leads with the newest version for "latest"', () => {
    const top = query('latest acme proposal').results[0]
    expect(top.primary.name).toMatch(/^Acme_Proposal_v3/)
    expect(top.versions.map((v) => v.name)).toEqual(['Acme_Proposal_v2.pdf', 'Acme_Proposal_v1.docx'])
    expect(top.reasons).toContainEqual({ kind: 'versions', count: 3, newest: true })
  })

  it('leads with the version whose file name was typed', () => {
    for (const v of ['v1', 'v2', 'v3']) {
      const top = query(`Acme_Proposal_${v}`).results[0]
      expect(top.primary.name).toMatch(new RegExp(`^Acme_Proposal_${v}`))
      expect(top.versions).toHaveLength(2)
    }
  })

  it('does not group unrelated files', () => {
    for (const r of query('notes planning booking invoice warranty').results) {
      if (!r.primary.name.startsWith('Acme_Proposal')) expect(r.versions).toEqual([])
    }
  })

  it('can be turned off for comparisons', () => {
    const vec = toUnitVec(fakeEmbed('search_query: acme proposal'))
    const flat = search.search('acme proposal', vec, { groupVersions: false }).results
    expect(flat.filter((x) => x.primary.name.startsWith('Acme_Proposal')).length).toBe(3)
  })
})

describe('passages in the document view (S4-05)', () => {
  it('locates each evidence passage in the document text', () => {
    const r = query('warranty period dishwasher').results.find((x) => x.primary.name.startsWith('Dishwasher'))!
    expect(r.evidence.length).toBeGreaterThan(0)
    const refs = r.evidence.map((e) => ({ chunkId: e.chunkId, start: e.chunkStart, end: e.chunkEnd }))
    const doc = readDocument(db, r.primary.fileId, refs)!
    expect(doc.passages).toHaveLength(r.evidence.length)
    for (const p of doc.passages) {
      const ev = r.evidence.find((e) => e.chunkId === p.chunkId)!
      const shown = ev.snippet.replace(/^…|…$/g, '')
      expect(doc.text.slice(p.start, p.end).replace(/\s+/g, ' ')).toBe(shown)
    }
  })

  it('ignores passages of other documents', () => {
    const other = query('lasagna bechamel').results[0].evidence[0]
    const dishwasher = query('dishwasher warranty').results.find((x) => x.primary.name.startsWith('Dishwasher'))!
    expect(readDocument(db, dishwasher.primary.fileId, [{ chunkId: other.chunkId, start: 0, end: 5 }])!.passages).toEqual([])
  })
})
