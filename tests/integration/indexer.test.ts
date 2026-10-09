import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { fakeEmbed } from '../support/fake-embeddings'

const embedCalls = { texts: 0 }

vi.mock('../../src/engine/ollama', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/engine/ollama')>()
  return {
    ...real,
    embed: async (_model: string, input: string[]) => {
      embedCalls.texts += input.length
      return input.map(fakeEmbed)
    }
  }
})

const { openDatabase, assertIndexConsistent } = await import('../../src/engine/db')
const { Indexer } = await import('../../src/engine/indexer')
const { SearchService } = await import('../../src/engine/search')
const { VectorIndex, toUnitVec } = await import('../../src/engine/vectors')
const { readDocument } = await import('../../src/engine/documents')
const { searchSuggestions } = await import('../../src/engine/suggestions')

const CORPUS = path.resolve('tests/fixtures/corpus')
// Not the OS temp dir: Recall refuses to index folders inside AppData.
const TMP_ROOT = path.resolve('tests/.tmp')

let dir: string
let docs: string
let db: ReturnType<typeof openDatabase>
let indexer: InstanceType<typeof Indexer>
let search: InstanceType<typeof SearchService>

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

const query = (q: string) => search.search(q, toUnitVec(fakeEmbed('search_query: ' + q)))
const names = (q: string) => query(q).results.map((r) => r.primary.name)

beforeAll(async () => {
  mkdirSync(TMP_ROOT, { recursive: true })
  dir = mkdtempSync(path.join(TMP_ROOT, 'run-'))
  docs = path.join(dir, 'docs')
  cpSync(CORPUS, docs, { recursive: true, preserveTimestamps: true })
  db = openDatabase(path.join(dir, 'recall.db'))
  const vectors = new VectorIndex(db)
  search = new SearchService(db, vectors)
  indexer = new Indexer(db, vectors, () => undefined, () => undefined)
  indexer.setAiReady(true)
  indexer.start()
  indexer.addFolder(docs)
  await settle()
})

afterAll(() => {
  indexer?.stop()
  db?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('indexing the fixture corpus', () => {
  it('indexes supported files and records failures without crashing', () => {
    const p = indexer.progress()
    expect(p.filesTotal).toBe(18)
    const failures = indexer.listFailures().map((f) => `${f.name}: ${f.reason}`)
    expect(failures).toContain('broken.pdf: File appears to be damaged')
    expect(failures).toContain('scanned-receipt.pdf: No text found (may be a scanned document)')
    assertIndexConsistent(db)
  })

  it('extracts PDF pages and DOCX headings', () => {
    const pdf = query('50% initial payment').results.find((r) => r.primary.name === 'Acme_Proposal_v2.pdf')!
    expect(pdf.evidence[0].location).toMatch(/^pp?\. .*2$/)
    const docx = query('payment milestones upfront').results.find((r) => r.primary.name.startsWith('Acme_Proposal_v3'))!
    expect(docx.evidence[0].location).toBe('§ Payment terms')
  })

  it('finds the brief examples', () => {
    expect(names('Find the proposal where I discussed a 50% initial payment')[0]).toBe('Acme_Proposal_v2.pdf')
    expect(names('Which documents mention the warranty period?').slice(0, 3)).toContain('Dishwasher_DW-450_Manual.pdf')
    expect(names('meeting notes about improvements to the booking system').slice(0, 3)).toContain('2026-03-02 booking system retro.md')
    expect(names('source code file where I implemented authentication sessions')[0]).toBe('session.ts')
  })

  it('collapses identical copies into one result', () => {
    const r = query('40% upfront two payment milestones').results.find((x) => x.primary.name.startsWith('Acme_Proposal_v3'))!
    expect(r.copies).toHaveLength(1)
    const allNames = query('40% upfront two payment milestones').results.flatMap((x) => [x.primary.name, ...x.copies.map((c) => c.name)])
    expect(allNames.filter((n) => n.startsWith('Acme_Proposal_v3'))).toHaveLength(2)
  })

  it('matches file names even when the body lacks the words', () => {
    const r = query('bluebird').results[0]
    expect(r.primary.name).toMatch(/Bluebird|invoice/)
    expect(query('lisbon itinerary').results[0].reasons.some((x) => x.kind === 'filename')).toBe(true)
  })

  it('builds example searches from the indexed files that find those files', () => {
    const suggestions = searchSuggestions(db)
    expect(suggestions).toHaveLength(3)
    expect(new Set(suggestions.map((s) => s.contentId)).size).toBe(3)
    for (const s of suggestions) {
      // The file may be shown as a result, a copy, or one of a result's other versions.
      const target = new Set(search.filesFor(s.contentId).map((f) => f.fileId))
      const shown = query(s.query).results.slice(0, 3).flatMap((r) => [r.primary, ...r.copies, ...r.versions].map((f) => f.fileId))
      expect(shown.some((id) => target.has(id)), s.query).toBe(true)
    }
  })

  it('reconstructs the full document text for the detail view', () => {
    const id = query('dishwasher warranty').results.find((r) => r.primary.name.startsWith('Dishwasher'))!.primary.fileId
    const doc = readDocument(db, id)!
    expect(doc.text).toContain('The warranty period is 24 months')
    expect(doc.text).toContain('Connect the inlet hose')
    expect(doc.pageCount).toBe(2)
  })
})

describe('keeping the index current', () => {
  it('renames without re-extracting or re-embedding', async () => {
    const before = embedCalls.texts
    renameSync(path.join(docs, 'personal/recipes/lasagna.md'), path.join(docs, 'personal/recipes/family-lasagna.md'))
    indexer.rescanFolder(1)
    await settle()
    expect(names('bechamel parmesan lasagna')).toContain('family-lasagna.md')
    expect(names('bechamel parmesan lasagna')).not.toContain('lasagna.md')
    expect(embedCalls.texts).toBe(before)
    assertIndexConsistent(db)
  })

  it('picks up edits and deletions', async () => {
    writeFileSync(path.join(docs, 'notes/weekly-planning.txt'), 'Weekly planning - renegotiate the kayak rental contract.')
    unlinkSync(path.join(docs, 'personal/travel/lisbon-itinerary.txt'))
    indexer.rescanFolder(1)
    await settle()
    expect(names('kayak rental contract')[0]).toBe('weekly-planning.txt')
    const stale = query('dentist accountant VAT').results.flatMap((r) => r.evidence.map((e) => e.snippet))
    expect(stale.some((t) => t.includes('dentist'))).toBe(false)
    expect(names('Sintra tram pasteis')).not.toContain('lisbon-itinerary.txt')
    assertIndexConsistent(db)
  })

  it('drops a file that grows past the size cap from search', async () => {
    const invoice = path.join(docs, 'clients/bluebird/invoice-2025-118.txt')
    writeFileSync(invoice, 'Invoice line for the quarterly retainer.\n'.repeat(60_000)) // about 2.4 MB
    indexer.rescanFolder(1)
    await settle()
    const evidence = query('patient reminder kickoff instalment').results.flatMap((r) => r.evidence.map((e) => e.snippet))
    expect(evidence.some((t) => t.includes('kickoff instalment'))).toBe(false)
    expect(indexer.listFailures().map((f) => `${f.name}: ${f.reason}`)).toContain('invoice-2025-118.txt: Too large to index')
    assertIndexConsistent(db)
  })

  it('does not delete anything when the folder root disappears', async () => {
    const moved = docs + '-away'
    renameSync(docs, moved)
    indexer.rescanFolder(1)
    await new Promise((r) => setTimeout(r, 800))
    expect(indexer.listFolders()[0].status).toBe('unavailable')
    expect(names('dishwasher warranty')).toContain('Dishwasher_DW-450_Manual.pdf')
    renameSync(moved, docs)
  })

  it('removing a folder forgets all of its data', () => {
    indexer.removeFolder(1)
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n
    expect(count('SELECT count(*) n FROM files')).toBe(0)
    expect(count('SELECT count(*) n FROM contents')).toBe(0)
    expect(count('SELECT count(*) n FROM chunks')).toBe(0)
    expect(count('SELECT count(*) n FROM chunk_vectors')).toBe(0)
    expect(query('warranty').results).toHaveLength(0)
    assertIndexConsistent(db)
  })
})
