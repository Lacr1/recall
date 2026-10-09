// Retrieval evaluation with the real embedding model (plan doc 07 §5). Writes eval-results/latest.md.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { openDatabase } from '../../src/engine/db'
import { Indexer } from '../../src/engine/indexer'
import { embed } from '../../src/engine/ollama'
import { SearchService } from '../../src/engine/search'
import { toUnitVec, VectorIndex } from '../../src/engine/vectors'
import { EMBED_MODEL, QUERY_PREFIX } from '../../src/shared/constants'

interface Q { id: string; type: string; query: string; relevant: string[] }
const queries: Q[] = JSON.parse(readFileSync('tests/eval/queries.json', 'utf8'))

const TMP = path.resolve('tests/.tmp')
let dir: string
let db: ReturnType<typeof openDatabase>
let indexer: Indexer
let vectors: VectorIndex
let search: SearchService

beforeAll(async () => {
  mkdirSync(TMP, { recursive: true })
  dir = mkdtempSync(path.join(TMP, 'eval-'))
  cpSync('tests/fixtures/corpus', path.join(dir, 'docs'), { recursive: true, preserveTimestamps: true })
  db = openDatabase(path.join(dir, 'recall.db'))
  vectors = new VectorIndex(db)
  search = new SearchService(db, vectors)
  indexer = new Indexer(db, vectors, () => undefined, (e) => console.error('AI failure', e.code))
  indexer.setAiReady(true)
  indexer.start()
  indexer.addFolder(path.join(dir, 'docs'))
  const t0 = Date.now()
  for (;;) {
    const p = indexer.progress()
    if (!p.scanning && p.filesPending === 0 && p.readDone === p.readTotal && p.embedDone === p.embedTotal && p.embedTotal > 0) break
    if (Date.now() - t0 > 500_000) throw new Error('indexing timeout')
    await new Promise((r) => setTimeout(r, 250))
  }
  console.log(`Indexed in ${Date.now() - t0} ms: ${JSON.stringify(indexer.progress())}`)
})

afterAll(() => {
  indexer?.stop()
  db?.close()
  rmSync(dir, { recursive: true, force: true })
})

function fileNamesForContent(contentId: number): string[] {
  return search.filesFor(contentId).map((f) => f.name)
}

function metrics(ranked: string[][], relevant: string[]) {
  const rank = ranked.findIndex((names) => names.some((n) => relevant.includes(n)))
  const found = new Set(ranked.slice(0, 5).flat().filter((n) => relevant.includes(n)))
  // A content with several copies counts once: normalise relevant by unique contents found anywhere.
  const relevantContents = new Set(ranked.filter((names) => names.some((n) => relevant.includes(n))).map((n) => n.join('|')))
  const total = Math.max(1, Math.min(relevant.length, relevantContents.size || relevant.length))
  const r5 = Math.min(1, ranked.slice(0, 5).filter((names) => names.some((n) => relevant.includes(n))).length / total)
  return { mrr: rank >= 0 && rank < 10 ? 1 / (rank + 1) : 0, hit5: rank >= 0 && rank < 5 ? 1 : 0, r5, found: found.size }
}

it('compares keyword, semantic and hybrid retrieval', async () => {
  const rows: string[] = []
  const agg: Record<string, { mrr: number; hit5: number; r5: number; n: number }> = {}
  const cosPos: number[] = []
  const cosNeg: number[] = []
  const latencies: number[] = []
  const TAUS = [0.56, 0.58, 0.6, 0.61, 0.62, 0.63, 0.64, 0.66]
  const calib: Record<number, { neg: number; negN: number; pos: number; posN: number }> = {}
  const resultCounts = { baseline: [] as number[], hybrid: [] as number[] }
  const avg = (xs: number[]) => (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)

  for (const q of queries) {
    const t = performance.now()
    const [v] = await embed(EMBED_MODEL, [QUERY_PREFIX + q.query])
    const qv = toUnitVec(v)
    const hybrid = search.search(q.query, qv)
    latencies.push(performance.now() - t)
    const baseline = search.search(q.query, qv, { allTermsList: false, vectorMargin: Infinity })
    resultCounts.baseline.push(baseline.results.length)
    resultCounts.hybrid.push(hybrid.results.length)
    for (const tau of TAUS) {
      const flagged = search.search(q.query, qv, { lowConfidenceCosine: tau }).lowConfidence
      const c = (calib[tau] ??= { neg: 0, negN: 0, pos: 0, posN: 0 })
      if (q.relevant.length) { c.posN++; if (flagged) c.pos++ } else { c.negN++; if (flagged) c.neg++ }
    }
    const keyword = search.search(q.query, undefined)
    const semHits = vectors.search(qv, 100)
    const semContents: number[] = []
    for (const h of semHits) if (!semContents.includes(h.contentId)) semContents.push(h.contentId)

    const top = semHits[0]?.score ?? 0
    if (q.relevant.length) cosPos.push(top)
    else cosNeg.push(top)

    const modes = {
      keyword: keyword.results.map((r) => [r.primary.name, ...r.copies.map((c) => c.name)]),
      semantic: semContents.map(fileNamesForContent),
      'hybrid (RRF baseline)': baseline.results.map((r) => [r.primary.name, ...r.copies.map((c) => c.name)]),
      hybrid: hybrid.results.map((r) => [r.primary.name, ...r.copies.map((c) => c.name)])
    }
    if (!q.relevant.length) {
      rows.push(`| ${q.id} | negative | top cosine ${top.toFixed(3)} | hybrid top: ${modes.hybrid[0]?.[0] ?? '—'} |`)
      continue
    }
    const cells: string[] = []
    for (const [mode, ranked] of Object.entries(modes)) {
      const m = metrics(ranked, q.relevant)
      const a = (agg[mode] ??= { mrr: 0, hit5: 0, r5: 0, n: 0 })
      a.mrr += m.mrr
      a.hit5 += m.hit5
      a.r5 += m.r5
      a.n++
      cells.push(`${mode} ${m.mrr.toFixed(2)}`)
    }
    rows.push(`| ${q.id} | ${q.type} | ${cells.join(' · ')} | hybrid top: ${modes.hybrid[0]?.[0] ?? '—'} (cos ${top.toFixed(3)}) |`)
  }

  const summary = Object.entries(agg).map(
    ([mode, a]) => `| ${mode} | ${(a.hit5 / a.n).toFixed(2)} | ${(a.r5 / a.n).toFixed(2)} | ${(a.mrr / a.n).toFixed(2)} |`
  )
  const stats = (xs: number[]) => (xs.length ? `min ${Math.min(...xs).toFixed(3)} · median ${xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)].toFixed(3)} · max ${Math.max(...xs).toFixed(3)}` : '—')
  latencies.sort((a, b) => a - b)
  const report = [
    `# Retrieval eval — ${new Date().toISOString()}`,
    '',
    `Model: ${EMBED_MODEL} · corpus: tests/fixtures/corpus (synthetic, 18 files) · ${queries.length} queries (${cosNeg.length} negative)`,
    '',
    '| Mode | Hit@5 | Recall@5 | MRR@10 |',
    '|---|---|---|---|',
    ...summary,
    '',
    `Top-1 cosine, answerable queries: ${stats(cosPos)}`,
    `Top-1 cosine, negative queries: ${stats(cosNeg)}`,
    `Average results per query: RRF baseline ${avg(resultCounts.baseline)} · hybrid ${avg(resultCounts.hybrid)}`,
    '',
    '| Low-confidence cosine τ | Negative queries flagged | Answerable queries wrongly flagged |',
    '|---|---|---|',
    ...TAUS.map((t) => `| ${t} | ${calib[t].neg}/${calib[t].negN} | ${calib[t].pos}/${calib[t].posN} |`),
    '',
    `Hybrid query latency incl. embedding (warm): p50 ${latencies[Math.floor(latencies.length / 2)].toFixed(0)} ms · max ${latencies.at(-1)!.toFixed(0)} ms`,
    '',
    '| Query | Type | MRR per mode | Notes |',
    '|---|---|---|---|',
    ...rows
  ].join('\n')
  mkdirSync('eval-results', { recursive: true })
  writeFileSync('eval-results/latest.md', report)
  console.log(report)
  expect(agg.hybrid.n).toBeGreaterThan(0)
})
