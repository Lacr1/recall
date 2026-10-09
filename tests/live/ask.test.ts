// Grounded answers with the real chat model (plan doc 04 §9). Prints answers for manual review.
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { runAsk } from '../../src/engine/ask'
import { openDatabase } from '../../src/engine/db'
import { Indexer } from '../../src/engine/indexer'
import { embed } from '../../src/engine/ollama'
import { SearchService } from '../../src/engine/search'
import { toUnitVec, VectorIndex } from '../../src/engine/vectors'
import { EMBED_MODEL, QUERY_PREFIX } from '../../src/shared/constants'
import type { AskEvent } from '../../src/shared/types'

let dir: string
let db: ReturnType<typeof openDatabase>
let indexer: Indexer
let search: SearchService

beforeAll(async () => {
  mkdirSync('tests/.tmp', { recursive: true })
  dir = mkdtempSync(path.resolve('tests/.tmp/ask-'))
  cpSync('tests/fixtures/corpus', path.join(dir, 'docs'), { recursive: true, preserveTimestamps: true })
  db = openDatabase(path.join(dir, 'recall.db'))
  const vectors = new VectorIndex(db)
  search = new SearchService(db, vectors)
  indexer = new Indexer(db, vectors, () => undefined, () => undefined)
  indexer.setAiReady(true)
  indexer.start()
  indexer.addFolder(path.join(dir, 'docs'))
  for (;;) {
    const p = indexer.progress()
    if (!p.scanning && p.filesPending === 0 && p.readDone === p.readTotal && p.embedTotal > 0 && p.embedDone === p.embedTotal) break
    await new Promise((r) => setTimeout(r, 250))
  }
})

afterAll(() => {
  indexer?.stop()
  db?.close()
  rmSync(dir, { recursive: true, force: true })
})

async function ask(question: string) {
  const [v] = await embed(EMBED_MODEL, [QUERY_PREFIX + question])
  const events: AskEvent[] = []
  const t0 = Date.now()
  await runAsk(db, search, 1, question, toUnitVec(v), new AbortController().signal, (e) => events.push(e))
  const sources = events.find((e) => e.type === 'sources')
  const answer = [...events].reverse().find((e) => e.type === 'token')
  const done = events.find((e) => e.type === 'done')
  console.log(`\nQ: ${question}\n(${Date.now() - t0} ms)\nSources: ${sources?.type === 'sources' ? sources.sources.map((s) => `[${s.n}] ${s.name}`).join(', ') : '-'}\nA: ${answer?.type === 'token' ? answer.text : '(none)'}\n${JSON.stringify(done)}`)
  return { answer: answer?.type === 'token' ? answer.text : '', done: done as Extract<AskEvent, { type: 'done' }> }
}

it('answers with citations from the files', async () => {
  const r = await ask('What payment terms did I propose to Acme, and did they change?')
  expect(r.done.insufficient).toBe(false)
  expect(r.answer).toMatch(/\[\d\]/)
  expect(r.answer).toMatch(/40|50/)
})

it('refuses when the files do not contain the answer', async () => {
  const r = await ask('When does my passport expire?')
  expect(r.done.insufficient || /not|no information|don.t/i.test(r.answer)).toBe(true)
})
