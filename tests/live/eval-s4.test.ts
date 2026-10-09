// Stage 4 retrieval evaluation (plan doc 07 §5, backlog S4-03) with the real embedding model.
// Corpus: tests/fixtures/eval-corpus (synthetic, mtimes from its manifest). Queries: tests/eval/queries-s4.jsonl.
// Reports gates, per-type and per-split tables, the experiments of 07 §5.5 that Stage 4 added (temporal
// re-ordering, version grouping, int8 vectors), low-confidence calibration and version-grouping quality.
// Writes eval-results/s4-eval.md. Run: npx vitest run --config vitest.live.config.ts tests/live/eval-s4.test.ts
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { openDatabase } from '../../src/engine/db'
import { Indexer } from '../../src/engine/indexer'
import { embed } from '../../src/engine/ollama'
import { SearchService, type SearchOptions } from '../../src/engine/search'
import { activeSpace } from '../../src/engine/spaces'
import { interpretQuery } from '../../src/engine/temporal'
import { queryTerms } from '../../src/shared/text'
import { toUnitVec, VectorIndex } from '../../src/engine/vectors'
import { compareNames, sameFamily, similarity, VERSION_RULE, versionFamilies } from '../../src/engine/versions'
import { stopOcr } from '../../src/engine/ocr'
import type { SearchResult } from '../../src/shared/types'

interface Query {
  id: string
  query: string
  type: string
  relevant: Record<string, number>
  split: 'tune' | 'holdout'
}
interface Manifest {
  files: Record<string, string>
  families?: { name: string; members: string[] }[]
  duplicates?: string[][]
  distractorPairs?: string[][]
}

const CORPUS = path.resolve('tests/fixtures/eval-corpus')
const manifest: Manifest = JSON.parse(readFileSync('tests/fixtures/eval-corpus.manifest.json', 'utf8'))
const queries: Query[] = readFileSync('tests/eval/queries-s4.jsonl', 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))

const TMP = path.resolve('tests/.tmp')
let dir: string
let root: string
let db: ReturnType<typeof openDatabase>
let indexer: Indexer
let int8: VectorIndex
let float: VectorIndex
let searchInt8: SearchService
let searchFloat: SearchService
let indexMs = 0

const posix = (p: string) => p.split(path.sep).join('/')
const rel = (abs: string) => posix(path.relative(root, abs))

beforeAll(async () => {
  mkdirSync(TMP, { recursive: true })
  dir = mkdtempSync(path.join(TMP, 'eval-s4-'))
  root = path.join(dir, 'files')
  cpSync(CORPUS, root, { recursive: true })
  for (const [p, iso] of Object.entries(manifest.files)) {
    const t = new Date(iso)
    try {
      utimesSync(path.join(root, p), t, t)
    } catch {
      // listed but not generated; the query check below reports it
    }
  }
  db = openDatabase(path.join(dir, 'recall.db'))
  int8 = new VectorIndex(db, { quantized: true })
  float = new VectorIndex(db, { quantized: false })
  searchInt8 = new SearchService(db, int8)
  searchFloat = new SearchService(db, float)
  indexer = new Indexer(db, int8, () => undefined, (e) => console.error('AI failure', e.code))
  indexer.setOcr(true)
  indexer.setAiReady(true)
  indexer.start()
  // Like a user's library: each top-level folder added separately.
  for (const name of ['business', 'clients', 'code', 'Downloads', 'finance', 'manuals', 'notes', 'personal', 'projects', 'scans']) {
    try {
      indexer.addFolder(path.join(root, name))
    } catch {
      // folder not in this corpus version
    }
  }
  const t0 = Date.now()
  for (;;) {
    const p = indexer.progress()
    if (!p.scanning && p.filesPending === 0 && p.readDone === p.readTotal && p.embedDone === p.embedTotal && p.embedTotal > 0) break
    if (Date.now() - t0 > 3_000_000) throw new Error('indexing timeout ' + JSON.stringify(p))
    await new Promise((r) => setTimeout(r, 500))
  }
  indexMs = Date.now() - t0
})

afterAll(async () => {
  indexer?.stop()
  await stopOcr()
  db?.close()
  rmSync(dir, { recursive: true, force: true })
})

// ---------- relevance units ----------

/** Byte-identical copies are one file for scoring (07 §5.3). */
const dupKey = new Map<string, string>()
for (const set of manifest.duplicates ?? []) for (const p of set) dupKey.set(p, [...set].sort()[0])
const unit = (p: string) => dupKey.get(p) ?? p

interface Scored {
  recall10: number
  mrr10: number
  ndcg10: number
  p5: number
  /** Grade-2 target shown as a result's file (not just listed as a version) within the top 5. */
  target5: number
}

/** Files a result shows directly, and files listed under it as other versions. */
const shown = (r: SearchResult) => [r.primary, ...r.copies].map((f) => rel(f.path))
const listed = (r: SearchResult) => r.versions.map((f) => rel(f.path))

function score(results: SearchResult[], relevant: Record<string, number>): Scored {
  const grade = (p: string) => relevant[p] ?? 0
  const units = new Map<string, number>()
  for (const [p, g] of Object.entries(relevant)) units.set(unit(p), Math.max(units.get(unit(p)) ?? 0, g))
  const top = results.slice(0, 10)
  const covered = new Set<string>()
  for (const r of top) for (const p of [...shown(r), ...listed(r)]) if (grade(p) > 0) covered.add(unit(p))
  const gains = top.map((r) => Math.max(0, ...shown(r).map(grade)))
  const first = gains.findIndex((g) => g > 0)
  const dcg = gains.reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0)
  const ideal = [...units.values()].sort((a, b) => b - a).slice(0, 10).reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0)
  const targets = new Set([...units].filter(([, g]) => g === 2).map(([u]) => u))
  return {
    recall10: units.size ? covered.size / units.size : 0,
    mrr10: first >= 0 ? 1 / (first + 1) : 0,
    ndcg10: ideal ? dcg / ideal : 0,
    p5: results.slice(0, 5).filter((r) => [...shown(r), ...listed(r)].some((p) => grade(p) > 0)).length / 5,
    target5: results.slice(0, 5).some((r) => shown(r).some((p) => targets.has(unit(p)))) ? 1 : 0
  }
}

// ---------- running queries ----------

const vecCache = new Map<string, Float32Array>()
async function queryVec(text: string): Promise<Float32Array | undefined> {
  if (!text.trim()) return undefined
  const space = activeSpace(db)
  const hit = vecCache.get(text)
  if (hit) return hit
  const [v] = await embed(space.model, [space.queryPrefix + text])
  const unitVec = toUnitVec(v)
  vecCache.set(text, unitVec)
  return unitVec
}

type Mode = 'keyword' | 'semantic' | 'hybrid' | 'hybrid, no time words' | 'hybrid, no version grouping' | 'hybrid, float32 vectors'
const MODES: Mode[] = ['keyword', 'semantic', 'hybrid', 'hybrid, no time words', 'hybrid, no version grouping', 'hybrid, float32 vectors']

async function run(q: Query, mode: Mode, extra: SearchOptions = {}): Promise<{ results: SearchResult[]; lowConfidence: boolean; ms: number }> {
  const t = performance.now()
  const temporal = mode !== 'hybrid, no time words'
  const { query, opts } = temporal ? interpretQuery(q.query) : { query: q.query, opts: {} }
  const vec = await queryVec(query)
  const service = mode === 'hybrid, float32 vectors' ? searchFloat : searchInt8
  let out: { results: SearchResult[]; lowConfidence: boolean }
  if (mode === 'keyword') out = service.search(query, undefined, opts)
  else if (mode === 'semantic') {
    // Meaning only: nearest chunks grouped to files, no keyword or name lists, no grouping.
    const hits = vec ? int8.search(vec, 100) : []
    const seen = new Set<number>()
    const results: SearchResult[] = []
    for (const h of hits) {
      if (seen.has(h.contentId)) continue
      seen.add(h.contentId)
      const files = service.filesFor(h.contentId)
      if (files.length) results.push({ contentId: h.contentId, primary: files[0], copies: files.slice(1), versions: [], evidence: [], reasons: [] })
    }
    out = { results, lowConfidence: false }
  } else out = service.search(query, vec, { ...opts, groupVersions: mode !== 'hybrid, no version grouping', ...extra })
  return { ...out, ms: performance.now() - t }
}

// ---------- the evaluation ----------

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
const f2 = (x: number) => (Number.isNaN(x) ? '—' : x.toFixed(2))
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]

it('Stage 4 evaluation', async () => {
  const missing = queries.flatMap((q) => Object.keys(q.relevant).filter((p) => !manifest.files[p]).map((p) => `${q.id}: ${p}`))
  const answerable = queries.filter((q) => Object.keys(q.relevant).length > 0)
  const negative = queries.filter((q) => Object.keys(q.relevant).length === 0)

  // Per mode, per query scores.
  const scores: Record<Mode, Map<string, Scored>> = Object.fromEntries(MODES.map((m) => [m, new Map()])) as never
  const latency: Record<string, number[]> = { int8: [], float32: [] }
  const topCos = new Map<string, number>()
  for (const q of queries) {
    for (const mode of MODES) {
      const r = await run(q, mode)
      if (Object.keys(q.relevant).length) scores[mode].set(q.id, score(r.results, q.relevant))
      if (mode === 'hybrid') latency.int8.push(r.ms)
      if (mode === 'hybrid, float32 vectors') latency.float32.push(r.ms)
    }
    const v = await queryVec(interpretQuery(q.query).query)
    topCos.set(q.id, v ? (int8.search(v, 1)[0]?.score ?? 0) : 0)
  }
  // Warm latency: a second pass of hybrid only, query vectors cached (search cost without Ollama).
  const warm = { int8: [] as number[], float32: [] as number[] }
  for (const q of queries) {
    warm.int8.push((await run(q, 'hybrid')).ms)
    warm.float32.push((await run(q, 'hybrid, float32 vectors')).ms)
  }

  const agg = (mode: Mode, filter: (q: Query) => boolean) => {
    const xs = answerable.filter(filter).map((q) => scores[mode].get(q.id)!)
    return {
      n: xs.length,
      recall10: mean(xs.map((s) => s.recall10)),
      mrr10: mean(xs.map((s) => s.mrr10)),
      ndcg10: mean(xs.map((s) => s.ndcg10)),
      p5: mean(xs.map((s) => s.p5)),
      target5: mean(xs.map((s) => s.target5))
    }
  }
  const row = (label: string, a: ReturnType<typeof agg>) =>
    `| ${label} | ${a.n} | ${f2(a.recall10)} | ${f2(a.mrr10)} | ${f2(a.ndcg10)} | ${f2(a.p5)} | ${f2(a.target5)} |`
  const head = ['| | Queries | Recall@10 | MRR@10 | nDCG@10 | P@5 | Target in top 5 |', '|---|---|---|---|---|---|---|']

  // ---------- low-confidence calibration (07 §5.4): τ chosen on the tune split, checked on holdout ----------
  const TAUS = [0.5, 0.52, 0.54, 0.56, 0.58, 0.6, 0.62, 0.64, 0.66, 0.68, 0.7]
  const flagRates = async (tau: number, split: 'tune' | 'holdout') => {
    let neg = 0
    let pos = 0
    const ns = negative.filter((q) => q.split === split)
    const ps = answerable.filter((q) => q.split === split)
    for (const q of [...ns, ...ps]) {
      const flagged = (await run(q, 'hybrid', { lowConfidenceCosine: tau })).lowConfidence
      if (Object.keys(q.relevant).length) pos += flagged ? 1 : 0
      else neg += flagged ? 1 : 0
    }
    return { neg: neg / Math.max(1, ns.length), pos: pos / Math.max(1, ps.length), nNeg: ns.length, nPos: ps.length }
  }
  const calib: { tau: number; tune: Awaited<ReturnType<typeof flagRates>>; holdout: Awaited<ReturnType<typeof flagRates>> }[] = []
  for (const tau of TAUS) calib.push({ tau, tune: await flagRates(tau, 'tune'), holdout: await flagRates(tau, 'holdout') })
  // Alternative rule shapes (plan 04 §6.5 allows revising the rule), scored from each query's top result.
  const feats = new Map<string, { cos: number; cov: number; agree: boolean; neg: boolean; split: string }>()
  for (const q of queries) {
    const { query } = interpretQuery(q.query)
    const top = (await run(q, 'hybrid')).results[0]
    const terms = queryTerms(query)
    const termReason = top?.reasons.find((r) => r.kind === 'terms') as { terms: string[] } | undefined
    feats.set(q.id, {
      cos: top?.debug?.bestCosine ?? 0,
      cov: terms.length ? (termReason?.terms.length ?? 0) / terms.length : 1,
      agree: !!top?.debug && (top.debug.kwRank ?? 99) <= 10 && (top.debug.vecRank ?? 99) <= 10,
      neg: !Object.keys(q.relevant).length,
      split: q.split
    })
  }
  const SHAPES: Record<string, (f: { cos: number; cov: number; agree: boolean }, tau: number) => boolean> = {
    'plan’s first rule: coverage < 0.5 and cosine < τ and lists disagree': (f, t) => f.cov < 0.5 && f.cos < t && !f.agree,
    'cosine < τ and lists disagree': (f, t) => f.cos < t && !f.agree,
    'cosine < τ': (f, t) => f.cos < t,
    'coverage < 1 and cosine < τ (shipped)': (f, t) => f.cov < 1 && f.cos < t
  }
  const shapeRows: string[] = []
  for (const [shape, flag] of Object.entries(SHAPES)) {
    const rate = (split: string, neg: boolean, tau: number) => {
      const xs = [...feats.values()].filter((f) => f.split === split && f.neg === neg)
      return xs.filter((f) => flag(f, tau)).length / Math.max(1, xs.length)
    }
    const ok = TAUS.filter((t) => rate('tune', true, t) >= 0.7 && rate('tune', false, t) <= 0.1)
    const best = ok.sort((a, b) => rate('tune', false, a) - rate('tune', false, b))[0]
    shapeRows.push(
      best === undefined
        ? `| ${shape} | — | none meets both on tune | | |`
        : `| ${shape} | ${best} | ${f2(rate('tune', true, best))} / ${f2(rate('tune', false, best))} | ${f2(rate('holdout', true, best))} | ${f2(rate('holdout', false, best))} |`
    )
  }
  const meeting = calib.filter((c) => c.tune.neg >= 0.7 && c.tune.pos <= 0.1)
  // Among τ meeting both targets on tune, the one with the fewest false flags; else the best trade-off.
  const chosen =
    meeting.sort((a, b) => a.tune.pos - b.tune.pos || b.tune.neg - a.tune.neg)[0] ??
    [...calib].sort((a, b) => b.tune.neg - b.tune.pos - (a.tune.neg - a.tune.pos))[0]

  // ---------- version grouping (S4-04) ----------
  const contentOf = (p: string) =>
    (db.prepare("SELECT x.content_id id FROM files x JOIN folders f ON f.id = x.folder_id WHERE f.path || '\\' || x.rel_path = ?").get(path.join(root, p)) as
      | { id: number }
      | undefined)?.id
  const familyPairs: [string, string][] = []
  for (const fam of manifest.families ?? []) {
    const members = fam.members.filter((p) => manifest.files[p])
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) familyPairs.push([members[i], members[j]])
  }
  const grouped = (a: string, b: string) => {
    const ca = contentOf(a)
    const cb = contentOf(b)
    if (ca === undefined || cb === undefined) return undefined
    if (ca === cb) return true // identical copies are one result anyway
    return (versionFamilies(db, [ca]).get(ca) ?? []).includes(cb)
  }
  const famResults = familyPairs.map(([a, b]) => grouped(a, b)).filter((x) => x !== undefined)
  const distractors = (manifest.distractorPairs ?? []).map(([a, b]) => grouped(a, b)).filter((x) => x !== undefined)
  const missedPairs = familyPairs.filter(([a, b]) => grouped(a, b) === false)
  const mergedLookalikes = (manifest.distractorPairs ?? []).filter(([a, b]) => grouped(a, b) === true)

  // Rule tuning: pair features from the stored signatures and names, against alternative thresholds.
  const sigOf = (p: string) => {
    const id = contentOf(p)
    const row = id && (db.prepare('SELECT minhash FROM content_signatures WHERE content_id = ?').get(id) as { minhash: Buffer } | undefined)
    return row ? new Uint32Array(new Uint8Array(row.minhash).buffer) : undefined
  }
  const features = (a: string, b: string) => {
    const sa = sigOf(a)
    const sb = sigOf(b)
    return sa && sb ? { sim: similarity(sa, sb), names: compareNames(path.basename(a), path.basename(b)) } : undefined
  }
  const famFeatures = familyPairs.map(([a, b]) => features(a, b)).filter((x) => !!x)
  const disFeatures = (manifest.distractorPairs ?? []).map(([a, b]) => features(a, b)).filter((x) => !!x)
  const RULES = [
    VERSION_RULE,
    { ...VERSION_RULE, datedNameJaccard: 0.25 },
    { ...VERSION_RULE, datedNameJaccard: 0.45 },
    { ...VERSION_RULE, sameNameJaccard: 0.05 },
    { ...VERSION_RULE, sameNameJaccard: 0.2 },
    { ...VERSION_RULE, sameNameJaccard: 0.3 },
    { ...VERSION_RULE, similarNameJaccard: 0.3 },
    { ...VERSION_RULE, similarNameJaccard: 0.5 },
    { ...VERSION_RULE, jaccardAlone: 0.75 }
  ]
  const ruleRows = RULES.map((rule) => {
    const tp = famFeatures.filter((f) => sameFamily(f.sim, f.names, rule)).length
    const fp = disFeatures.filter((f) => sameFamily(f.sim, f.names, rule)).length
    return `| ${rule.sameName}/${rule.sameNameJaccard} (dated ${rule.datedNameJaccard}) · ${rule.similarName}/${rule.similarNameJaccard} · ${rule.jaccardAlone}${rule === VERSION_RULE ? ' (shipped)' : ''} | ${tp}/${famFeatures.length} | ${fp}/${disFeatures.length} |`
  })

  // ---------- report ----------
  const hybrid = agg('hybrid', (q) => q.split === 'holdout')
  const hybridAll = agg('hybrid', () => true)
  const bestSingle = Math.max(agg('keyword', (q) => q.split === 'holdout').recall10, agg('semantic', (q) => q.split === 'holdout').recall10)
  const temporalQ = (q: Query) => q.type === 'temporal'
  const nonTemporal = (q: Query) => q.type !== 'temporal'
  const gates = [
    ['Hybrid Recall@10 (holdout)', '≥ 0.85', hybrid.recall10, hybrid.recall10 >= 0.85],
    ['Hybrid MRR@10 (holdout)', '≥ 0.60', hybrid.mrr10, hybrid.mrr10 >= 0.6],
    ['Hybrid − best single mode, Recall@10 (holdout)', '≥ +0.03', hybrid.recall10 - bestSingle, hybrid.recall10 - bestSingle >= 0.03],
    ['Negative queries flagged low-confidence (holdout, chosen τ)', '≥ 0.70', chosen.holdout.neg, chosen.holdout.neg >= 0.7],
    ['Answerable queries wrongly flagged (holdout, chosen τ)', '≤ 0.10', chosen.holdout.pos, chosen.holdout.pos <= 0.1],
    ['S4-02 temporal: intended version in top 5', '≥ 0.80', agg('hybrid', temporalQ).target5, agg('hybrid', temporalQ).target5 >= 0.8],
    [
      'S4-02 non-temporal Recall@10 change from time words',
      '±0.01',
      agg('hybrid', nonTemporal).recall10 - agg('hybrid, no time words', nonTemporal).recall10,
      Math.abs(agg('hybrid', nonTemporal).recall10 - agg('hybrid, no time words', nonTemporal).recall10) <= 0.01
    ],
    [
      'S4-09 int8 Recall@10 loss vs float32',
      '≤ 0.01',
      agg('hybrid, float32 vectors', () => true).recall10 - hybridAll.recall10,
      agg('hybrid, float32 vectors', () => true).recall10 - hybridAll.recall10 <= 0.01
    ],
    ['S4-04 version pairs grouped', 'report', mean(famResults.map((x) => (x ? 1 : 0))), true],
    ['S4-04 false merges on template look-alikes', '< 0.05', mean(distractors.map((x) => (x ? 1 : 0))), mean(distractors.map((x) => (x ? 1 : 0))) < 0.05 || distractors.length === 0]
  ] as const
  const types = [...new Set(answerable.map((q) => q.type))]
  const p = indexer.progress()
  const space = activeSpace(db)
  const cos = (qs: Query[]) => qs.map((q) => topCos.get(q.id)!).sort((a, b) => a - b)
  const report = [
    `# Stage 4 retrieval evaluation — ${new Date().toISOString()}`,
    '',
    `Machine: ${os.cpus()[0].model.trim()}, ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB RAM · model ${space.model} (${space.dims} dims) · OCR on`,
    `Corpus: tests/fixtures/eval-corpus, ${Object.keys(manifest.files).length} files (${p.filesTotal} indexed, ${p.chunks} chunks, ${p.failed} failed, ${p.skipped} skipped) · indexed in ${(indexMs / 1000).toFixed(0)} s`,
    `Queries: ${queries.length} (${answerable.length} answerable, ${negative.length} negative; ${queries.filter((q) => q.split === 'holdout').length} holdout)`,
    missing.length ? `\n**Relevant paths not in the corpus (${missing.length}):** ${missing.slice(0, 10).join('; ')}` : '',
    '',
    '## Gates (plan doc 07 §5.4 and backlog S4)',
    '',
    '| Gate | Target | Measured | Met |',
    '|---|---|---|---|',
    ...gates.map(([g, t, v, ok]) => `| ${g} | ${t} | ${f2(v as number)} | ${ok ? 'yes' : '**no**'} |`),
    '',
    '## Modes and experiments, all answerable queries',
    '',
    ...head,
    ...MODES.map((m) => row(m, agg(m, () => true))),
    '',
    '## Hybrid by split',
    '',
    ...head,
    row('tune', agg('hybrid', (q) => q.split === 'tune')),
    row('holdout', agg('hybrid', (q) => q.split === 'holdout')),
    '',
    '## Hybrid by query type',
    '',
    ...head,
    ...types.map((t) => row(t, agg('hybrid', (q) => q.type === t))),
    '',
    '## Low-confidence threshold τ (07 §5.4; chosen on tune, checked on holdout)',
    '',
    '| τ | Negative flagged (tune) | Answerable flagged (tune) | Negative flagged (holdout) | Answerable flagged (holdout) |',
    '|---|---|---|---|---|',
    ...calib.map(
      (c) =>
        `| ${c.tau}${c === chosen ? ' **(chosen)**' : ''} | ${f2(c.tune.neg)} | ${f2(c.tune.pos)} | ${f2(c.holdout.neg)} | ${f2(c.holdout.pos)} |`
    ),
    '',
    'Other rule shapes, τ chosen on tune (lowest false-flag rate meeting both targets):',
    '',
    '| Rule | τ | Tune: negative / answerable flagged | Holdout negative flagged | Holdout answerable flagged |',
    '|---|---|---|---|---|',
    ...shapeRows,
    '',
    `Top-1 cosine: answerable median ${f2(pct(cos(answerable), 0.5))} (min ${f2(cos(answerable)[0])}); negative median ${f2(pct(cos(negative), 0.5))} (max ${f2(cos(negative).at(-1)!)})`,
    '',
    '## Version grouping (S4-04)',
    '',
    `Families: ${manifest.families?.length ?? 0} (${famResults.length} member pairs, ${famResults.filter(Boolean).length} grouped). Template look-alike pairs: ${distractors.length} (${distractors.filter(Boolean).length} wrongly grouped).`,
    '',
    '| Rule (same name / Jaccard (dated names) · similar name / Jaccard · Jaccard alone) | Family pairs grouped | Look-alikes merged |',
    '|---|---|---|',
    ...ruleRows,
    '',
    ...missedPairs.map(([a, b]) => {
      const f = features(a, b)
      return `- Version pair not grouped: ${a} ↔ ${b} (Jaccard ${f2(f?.sim ?? NaN)}, names ${f2(f?.names.names ?? NaN)}${f?.names.datesDiffer ? ", dates differ" : ""})`
    }),
    ...mergedLookalikes.map(([a, b]) => {
      const f = features(a, b)
      return `- Look-alike pair grouped: ${a} ↔ ${b} (Jaccard ${f2(f?.sim ?? NaN)}, names ${f2(f?.names.names ?? NaN)}${f?.names.datesDiffer ? ", dates differ" : ""})`
    }),
    '',
    '## Speed and memory (S4-09)',
    '',
    `Hybrid search, query vector cached: int8 p50 ${f2(pct(warm.int8, 0.5))} ms · p95 ${f2(pct(warm.int8, 0.95))} ms; float32 p50 ${f2(pct(warm.float32, 0.5))} ms · p95 ${f2(pct(warm.float32, 0.95))} ms`,
    `Vector memory: int8 ${(int8.vectorBytes / 1024).toFixed(0)} KB vs float32 ${(float.vectorBytes / 1024).toFixed(0)} KB (${(float.vectorBytes / int8.vectorBytes).toFixed(2)}× smaller)`,
    '',
    '## Per query (hybrid)',
    '',
    '| Query | Type | Split | Recall@10 | MRR@10 | Target in top 5 |',
    '|---|---|---|---|---|---|',
    ...answerable.map((q) => {
      const s = scores.hybrid.get(q.id)!
      return `| ${q.id} | ${q.type} | ${q.split} | ${f2(s.recall10)} | ${f2(s.mrr10)} | ${s.target5} |`
    })
  ].join('\n')
  mkdirSync('eval-results', { recursive: true })
  writeFileSync('eval-results/s4-eval.md', report)
  console.log(report)
  expect(answerable.length).toBeGreaterThan(0)
})
