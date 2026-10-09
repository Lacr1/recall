import type { DB } from './db'
import type { VectorIndex } from './vectors'
import type { Evidence, FileRef, HighlightRange, MatchReason, SearchFilters, SearchResult, TypeFilter } from '../shared/types'
import { findTerm, findTerms, queryTerms } from '../shared/text'
import { activeSpace } from './spaces'
import { versionFamilies } from './versions'
import type { Kind } from './paths'

export { queryTerms }

const RRF_K = 60 // Cormack, Clarke & Büttcher (SIGIR 2009)
const K_KW = 100
const K_VEC = 100
const K_NAME = 50
const K_NEWEST = 50 // plan doc 04 §6.6: the recency list re-ranks only the top candidates
const MAX_RESULTS = 30
const SNIPPET_CHARS = 320

const TYPE_KINDS: Record<TypeFilter, Kind[]> = { pdf: ['pdf'], docx: ['docx'], notes: ['text', 'markdown'], code: ['code'], images: ['image'] }

/**
 * SQL predicate over `files x` for linked files passing the filters (plan doc 04 §6.3). Every candidate
 * list uses it, so filtering happens before ranking rather than after.
 */
export function filePredicate(filters: SearchFilters = {}): { sql: string; params: (string | number)[] } {
  const parts = ["x.status = 'linked'", 'x.content_id IS NOT NULL']
  const params: (string | number)[] = []
  if (filters.type) {
    const kinds = TYPE_KINDS[filters.type]
    parts.push(`EXISTS (SELECT 1 FROM contents k WHERE k.id = x.content_id AND k.kind IN (${kinds.map(() => '?').join(', ')}))`)
    params.push(...kinds)
  }
  if (filters.folderId !== undefined) {
    parts.push('x.folder_id = ?')
    params.push(filters.folderId)
  }
  if (filters.modified) {
    parts.push('x.mtime_ms >= ? AND x.mtime_ms < ?')
    params.push(filters.modified.from, filters.modified.to)
  }
  return { sql: parts.join(' AND '), params }
}

export function hasFilters(f: SearchFilters = {}): boolean {
  return !!(f.type || f.folderId !== undefined || f.modified)
}

/** Builds a safe FTS5 MATCH expression: every term quoted. Never passes raw user syntax. */
export function ftsQuery(terms: string[], op: 'OR' | 'AND' = 'OR'): string | undefined {
  if (!terms.length) return undefined
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(` ${op} `)
}

export interface SearchOptions {
  /** Add a ranked list of chunks containing every query term (default on). */
  allTermsList?: boolean
  /** Drop results found only by meaning whose cosine is this far below the best (default VECTOR_MARGIN). */
  vectorMargin?: number
  /** Cosine below which a weak top result is flagged low-confidence (default from settings / calibration). */
  lowConfidenceCosine?: number
  /**
   * 'search' (default): the Stage 4 rule behind "No strong matches". 'ask': the plan's first, more lenient
   * rule, which Ask uses to decide whether there is evidence to answer from and was validated with (S6).
   */
  lowConfidenceRule?: 'search' | 'ask'
  filters?: SearchFilters
  /** The query asked for the latest version: add a list of the top candidates ranked newest first. */
  newest?: boolean
  /** Show one result per version family (default on; off for eval comparisons). */
  groupVersions?: boolean
}

// Calibrated with tests/live/eval.test.ts on the synthetic corpus (nomic-embed-text). See eval-results/.
// The low-confidence cosine is per model and lives with the embedding space (spaces.ts).
export const VECTOR_MARGIN = 0.1

export interface Candidate {
  chunkId: number
  contentId: number
}

export interface RankedLists {
  keyword: Candidate[]
  keywordAll?: Candidate[]
  vector: (Candidate & { score: number })[]
  name: { fileId: number; contentId: number }[]
}

/** Reciprocal Rank Fusion at chunk level, then max-aggregated per content, plus file-name list. */
export function fuse(lists: RankedLists): Map<number, { score: number; chunkScores: Map<number, number>; kwRank?: number; vecRank?: number; nameRank?: number; bestCosine?: number }> {
  const contents = new Map<number, { score: number; chunkScores: Map<number, number>; kwRank?: number; vecRank?: number; nameRank?: number; bestCosine?: number }>()
  const chunkScore = new Map<number, { contentId: number; score: number }>()
  const add = (c: Candidate, rank: number) => {
    const cur = chunkScore.get(c.chunkId) ?? { contentId: c.contentId, score: 0 }
    cur.score += 1 / (RRF_K + rank + 1)
    chunkScore.set(c.chunkId, cur)
  }
  const entry = (contentId: number) => {
    let e = contents.get(contentId)
    if (!e) contents.set(contentId, (e = { score: 0, chunkScores: new Map() }))
    return e
  }
  // A chunk containing every query term is counted in both keyword lists: strong lexical evidence.
  for (const list of [lists.keywordAll ?? [], lists.keyword]) {
    list.forEach((c, i) => {
      add(c, i)
      const e = entry(c.contentId)
      e.kwRank = Math.min(e.kwRank ?? Infinity, i + 1)
    })
  }
  lists.vector.forEach((c, i) => {
    add(c, i)
    const e = entry(c.contentId)
    e.vecRank ??= i + 1
    e.bestCosine = Math.max(e.bestCosine ?? -1, c.score)
  })
  for (const [chunkId, { contentId, score }] of chunkScore) {
    const e = entry(contentId)
    e.chunkScores.set(chunkId, score)
    e.score = Math.max(e.score, score)
  }
  lists.name.forEach((n, i) => {
    const e = entry(n.contentId)
    if (e.nameRank === undefined) {
      e.nameRank = i + 1
      e.score += 1 / (RRF_K + i + 1)
    }
  })
  return contents
}

export class SearchService {
  constructor(
    private readonly db: DB,
    private readonly vectors: VectorIndex
  ) {}

  /**
   * @param queryVec unit query vector, or undefined for keyword-only mode
   */
  search(q: string, queryVec: Float32Array | undefined, opts: SearchOptions = {}): { results: SearchResult[]; lowConfidence: boolean } {
    const terms = queryTerms(q)
    const match = ftsQuery(terms)
    const pred = filePredicate(opts.filters)

    // Nothing to search for but filters or time words ("files from last week"): list what matches, newest first.
    if (!terms.length && (hasFilters(opts.filters) || opts.newest)) {
      return { results: this.newestFiles(pred, opts.groupVersions ?? true), lowConfidence: false }
    }

    const keywordList = (expr: string): Candidate[] =>
      this.db
        .prepare(
          `SELECT c.id chunkId, c.content_id contentId FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
           WHERE chunks_fts MATCH ? AND c.content_id IN (SELECT x.content_id FROM files x WHERE ${pred.sql})
           ORDER BY bm25(chunks_fts) LIMIT ?`
        )
        .all(expr, ...pred.params, K_KW) as Candidate[]
    const keyword = match ? keywordList(match) : []
    const keywordAll = (opts.allTermsList ?? true) && terms.length >= 2 ? keywordList(ftsQuery(terms, 'AND')!) : []

    // File names are indexed with letters and digits split ("Proposal V 3"); split the query the same way.
    const nameMatch = ftsQuery(queryTerms(q.replace(/(\p{L})(\p{N})/gu, '$1 $2').replace(/(\p{N})(\p{L})/gu, '$1 $2')))
    const name = nameMatch
      ? (this.db
          .prepare(
            `SELECT x.id fileId, x.content_id contentId FROM files_fts JOIN files x ON x.id = files_fts.rowid
             WHERE files_fts MATCH ? AND ${pred.sql} ORDER BY bm25(files_fts, 5.0, 1.0) LIMIT ?`
          )
          .all(nameMatch, ...pred.params, K_NAME) as { fileId: number; contentId: number }[])
      : []

    let vector: (Candidate & { score: number })[] = []
    if (queryVec) {
      const allowed = this.allowedContents(pred)
      vector = this.vectors.search(queryVec, K_VEC, (cid) => allowed.has(cid))
    }

    const fused = fuse({ keyword, keywordAll, vector, name })
    // Meaning search always returns nearest neighbours, however weak. Keep meaning-only results
    // only when they are close to the best match, so unrelated files don't pad the list.
    const margin = opts.vectorMargin ?? VECTOR_MARGIN
    const bestCos = vector[0]?.score ?? 0
    const byScore = (a: [number, { score: number }], b: [number, { score: number }]) => b[1].score - a[1].score
    const ranked = [...fused.entries()]
      .filter(([, f]) => f.kwRank !== undefined || f.nameRank !== undefined || (f.bestCosine ?? -1) >= bestCos - margin)
      .sort(byScore)
    const newestFirst = opts.newest ? this.addNewestList(ranked, pred) : undefined
    if (newestFirst !== undefined) ranked.sort(byScore)

    const fusedOf = new Map(ranked)
    // A query made only of one file's name words ("Acme_Proposal_v3") asks for that file, not its family's best match.
    const nameHit = ranked.find(([, f]) => f.nameRank === 1)?.[0]
    const nameHitName = nameHit !== undefined ? (this.filesFor(nameHit, pred)[0]?.name.toLowerCase() ?? '') : ''
    const topByName = nameHit !== undefined && terms.length > 0 && terms.every((t) => nameHitName.includes(t)) ? nameHit : undefined
    const groups = this.groupVersions(
      ranked.slice(0, MAX_RESULTS * 2).map(([cid]) => cid),
      !!opts.newest,
      pred,
      opts.groupVersions ?? true,
      topByName
    )
    const results: SearchResult[] = []
    for (const g of groups.slice(0, MAX_RESULTS)) {
      const f = fusedOf.get(g.primary)!
      const bestChunks = [...f.chunkScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id)
      const result = this.buildResult(g.primary, bestChunks, terms, pred)
      if (!result) continue
      if (f.vecRank !== undefined && f.vecRank <= 10) result.reasons.push({ kind: 'meaning', location: result.evidence[0]?.location })
      if (f.nameRank !== undefined) result.reasons.push({ kind: 'filename' })
      if (g.primary === newestFirst) result.reasons.push({ kind: 'newest' })
      this.attachVersions(result, g.versions, pred)
      result.debug = { score: f.score, kwRank: f.kwRank, vecRank: f.vecRank, nameRank: f.nameRank, bestCosine: f.bestCosine }
      results.push(result)
    }

    return { results, lowConfidence: this.isLowConfidence(results, terms, !!queryVec, opts.lowConfidenceCosine, opts.lowConfidenceRule) }
  }

  /**
   * Plan doc 04 §6.4 (S4-04): one result per version family, in rank order. The family's best-ranked member
   * leads; for "latest"-type queries the newest ranked member does (§6.6); and a member whose file name is the
   * best name match leads, so typing a version's name shows that version. Other members become `versions`.
   */
  private groupVersions(
    ordered: number[],
    newest: boolean,
    pred: ReturnType<typeof filePredicate>,
    enabled: boolean,
    topByName?: number
  ): { primary: number; versions: number[] }[] {
    if (!enabled) return ordered.map((primary) => ({ primary, versions: [] }))
    const families = versionFamilies(this.db, ordered)
    const inList = new Set(ordered)
    const mtime = this.db.prepare(`SELECT max(x.mtime_ms) m FROM files x WHERE x.content_id = ? AND ${pred.sql}`)
    const mtimeOf = (cid: number) => (mtime.get(cid, ...pred.params) as { m: number | null }).m ?? 0
    const taken = new Set<number>()
    const out: { primary: number; versions: number[] }[] = []
    for (const cid of ordered) {
      if (taken.has(cid)) continue
      const family = [cid, ...(families.get(cid) ?? [])].filter((m) => mtimeOf(m) > 0) // members passing the filters
      family.forEach((m) => taken.add(m))
      const primary = newest
        ? (family.filter((m) => inList.has(m)).sort((a, b) => mtimeOf(b) - mtimeOf(a))[0] ?? cid)
        : topByName !== undefined && family.includes(topByName)
          ? topByName
          : cid
      out.push({ primary, versions: family.filter((m) => m !== primary) })
    }
    return out
  }

  private attachVersions(result: SearchResult, versionIds: number[], pred: ReturnType<typeof filePredicate>): void {
    result.versions = versionIds
      .map((cid) => this.filesFor(cid, pred)[0])
      .filter((f): f is FileRef => !!f)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    if (result.versions.length) {
      result.reasons.push({ kind: 'versions', count: result.versions.length + 1, newest: result.versions.every((v) => v.mtimeMs <= result.primary.mtimeMs) })
    }
  }

  /**
   * Plan doc 04 §6.6: a fourth RRF list over the top candidates, ordered by modified date. Recency only
   * re-orders files that already matched, so a newer unrelated file can't outrank an older relevant one.
   * Updates scores in place and returns the newest candidate's content id.
   */
  private addNewestList(ranked: [number, { score: number }][], pred: ReturnType<typeof filePredicate>): number | undefined {
    const mtime = this.db.prepare(`SELECT max(x.mtime_ms) m FROM files x WHERE x.content_id = ? AND ${pred.sql}`)
    const top = ranked.slice(0, K_NEWEST).map(([cid, f]) => ({ f, cid, m: (mtime.get(cid, ...pred.params) as { m: number | null }).m ?? 0 }))
    top.sort((a, b) => b.m - a.m)
    top.forEach((t, i) => (t.f.score += 1 / (RRF_K + i + 1)))
    return top[0]?.cid
  }

  private newestFiles(pred: ReturnType<typeof filePredicate>, groupVersions: boolean): SearchResult[] {
    const rows = this.db
      .prepare(`SELECT x.content_id contentId, max(x.mtime_ms) m FROM files x WHERE ${pred.sql} GROUP BY x.content_id ORDER BY m DESC LIMIT ?`)
      .all(...pred.params, MAX_RESULTS * 2) as { contentId: number }[]
    const results: SearchResult[] = []
    for (const g of this.groupVersions(rows.map((r) => r.contentId), true, pred, groupVersions).slice(0, MAX_RESULTS)) {
      const r = this.buildResult(g.primary, [], [], pred)
      if (!r) continue
      r.reasons = [{ kind: 'filters' }]
      this.attachVersions(r, g.versions, pred)
      results.push(r)
    }
    return results
  }

  /** A result with its matching files, up to 3 evidence passages (the content's first chunk when none ranked) and term reasons. */
  private buildResult(contentId: number, chunkIds: number[], terms: string[], pred: ReturnType<typeof filePredicate>): SearchResult | undefined {
    const files = this.filesFor(contentId, pred)
    if (!files.length) return undefined
    const content = this.db.prepare('SELECT title FROM contents WHERE id = ?').get(contentId) as { title: string | null } | undefined
    const bestChunks = [...chunkIds]
    if (!bestChunks.length) {
      const first = this.db.prepare('SELECT id FROM chunks WHERE content_id = ? ORDER BY ord LIMIT 1').get(contentId) as { id: number } | undefined
      if (first) bestChunks.push(first.id)
    }
    const evidence = bestChunks.map((id) => this.evidence(id, terms)).filter((e): e is Evidence => !!e)
    const reasons: MatchReason[] = []
    const matched = this.matchedTerms(bestChunks, terms)
    if (matched.length) reasons.push({ kind: 'terms', terms: matched })
    return { contentId, primary: files[0], copies: files.slice(1), versions: [], title: content?.title ?? undefined, evidence, reasons }
  }

  /**
   * Plan doc 04 §6.5, rule revised in Stage 4: low confidence when the top result lacks some query words and
   * its meaning similarity is weak. The plan's first rule (under half the words, weak similarity, lists
   * disagree) could not flag 70% of negative queries at any threshold on the Stage 4 eval set
   * (eval-results/s4-eval.md). The cosine threshold is model-specific and was calibrated on that set's tune
   * split; a `lowConfidenceCosine` setting overrides it.
   */
  private isLowConfidence(results: SearchResult[], terms: string[], semantic: boolean, tauOverride?: number, rule: 'search' | 'ask' = 'search'): boolean {
    if (!results.length) return false
    const top = results[0]
    const termReason = top.reasons.find((r) => r.kind === 'terms') as { terms: string[] } | undefined
    const coverage = terms.length ? (termReason?.terms.length ?? 0) / terms.length : 1
    if (!semantic) return coverage < 0.5
    const tauRow = this.db.prepare("SELECT value FROM settings WHERE key = 'lowConfidenceCosine'").get() as { value: string } | undefined
    const tau = tauOverride ?? (tauRow ? Number(tauRow.value) : activeSpace(this.db).lowConfidenceCosine)
    // A model nobody has calibrated has no threshold; the flag stays off rather than guess one.
    if (tau === null) return false
    const cosine = top.debug?.bestCosine ?? 0
    if (rule === 'ask') {
      const agree = top.debug?.kwRank !== undefined && top.debug.kwRank <= 10 && top.debug?.vecRank !== undefined && top.debug.vecRank <= 10
      return coverage < 0.5 && cosine < tau && !agree
    }
    return coverage < 1 && cosine < tau
  }

  private allowedContents(pred: ReturnType<typeof filePredicate>): Set<number> {
    const rows = this.db.prepare(`SELECT DISTINCT x.content_id id FROM files x WHERE ${pred.sql}`).all(...pred.params) as { id: number }[]
    return new Set(rows.map((r) => r.id))
  }

  /** The content's files that pass the filters, most recently modified first. */
  filesFor(contentId: number, pred = filePredicate()): FileRef[] {
    return this.db
      .prepare(
        `SELECT x.id fileId, x.name, f.path || '\\' || x.rel_path path, f.path folderPath, x.ext, x.size, x.mtime_ms mtimeMs
         FROM files x JOIN folders f ON f.id = x.folder_id WHERE x.content_id = ? AND ${pred.sql} ORDER BY x.mtime_ms DESC, path`
      )
      .all(contentId, ...pred.params) as FileRef[]
  }

  private matchedTerms(chunkIds: number[], terms: string[]): string[] {
    if (!terms.length || !chunkIds.length) return []
    const text = chunkIds
      .map((id) => (this.db.prepare('SELECT text FROM chunks WHERE id = ?').get(id) as { text: string } | undefined)?.text ?? '')
      .join('\n')
    return terms.filter((t) => findTerm(text, t).length > 0)
  }

  private evidence(chunkId: number, terms: string[]): Evidence | undefined {
    const row = this.db.prepare('SELECT text, page_start, page_end, section_path FROM chunks WHERE id = ?').get(chunkId) as
      | { text: string; page_start: number | null; page_end: number | null; section_path: string | null }
      | undefined
    if (!row) return undefined
    const { snippet, highlights, start, end } = makeSnippet(row.text, terms)
    return { chunkId, snippet, highlights, location: locationLabel(row.page_start, row.page_end, row.section_path), chunkStart: start, chunkEnd: end }
  }
}

export function locationLabel(pageStart: number | null, pageEnd: number | null, section: string | null): string | undefined {
  if (pageStart) return pageEnd && pageEnd !== pageStart ? `pp. ${pageStart}–${pageEnd}` : `p. ${pageStart}`
  if (section) return `§ ${section.split(' › ').slice(-1)[0]}`
  return undefined
}

/**
 * Picks the window with the most matched terms; returns highlight offsets relative to the snippet and the
 * window's [start, end) in `text`.
 */
export function makeSnippet(text: string, terms: string[]): { snippet: string; highlights: HighlightRange[]; start: number; end: number } {
  const hits = terms.flatMap((t) => findTerm(text, t)).sort((a, b) => a.start - b.start)
  let start = 0
  if (hits.length && text.length > SNIPPET_CHARS) {
    let best = 0
    let bestCount = -1
    for (let i = 0; i < hits.length; i++) {
      let j = i
      while (j < hits.length && hits[j].end - hits[i].start <= SNIPPET_CHARS) j++
      if (j - i > bestCount) {
        bestCount = j - i
        best = i
      }
    }
    start = Math.max(0, hits[best].start - 60)
  }
  let end = Math.min(text.length, start + SNIPPET_CHARS)
  // Align to word boundaries.
  if (start > 0) {
    const sp = text.indexOf(' ', start)
    if (sp > 0 && sp < start + 30) start = sp + 1
  }
  if (end < text.length) {
    const sp = text.lastIndexOf(' ', end)
    if (sp > start + SNIPPET_CHARS / 2) end = sp
  }
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  const body = text.slice(start, end).replace(/\s+/g, ' ')
  // Recompute highlights on the whitespace-collapsed body.
  const highlights = findTerms(body, terms).map((h) => ({ start: h.start + prefix.length, end: h.end + prefix.length }))
  return { snippet: prefix + body + suffix, highlights, start, end }
}
