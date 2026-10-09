import type { DB } from './db'
import type { VectorIndex } from './vectors'
import type { Evidence, FileRef, HighlightRange, MatchReason, SearchResult } from '../shared/types'
import { findTerm, findTerms, queryTerms } from '../shared/text'

export { queryTerms }

const RRF_K = 60 // Cormack, Clarke & Büttcher (SIGIR 2009)
const K_KW = 100
const K_VEC = 100
const K_NAME = 50
const MAX_RESULTS = 30
const SNIPPET_CHARS = 320

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
}

// Calibrated with tests/live/eval.test.ts on the synthetic corpus (nomic-embed-text). See eval-results/.
export const VECTOR_MARGIN = 0.1
export const DEFAULT_LOW_CONFIDENCE_COSINE = 0.62

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
    const live = this.liveContents()

    const keywordList = (expr: string): Candidate[] =>
      (this.db
        .prepare(
          `SELECT c.id chunkId, c.content_id contentId FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
           WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?`
        )
        .all(expr, K_KW * 2) as Candidate[]).filter((c) => live.has(c.contentId)).slice(0, K_KW)
    const keyword = match ? keywordList(match) : []
    const keywordAll = (opts.allTermsList ?? true) && terms.length >= 2 ? keywordList(ftsQuery(terms, 'AND')!) : []

    const name = match
      ? (this.db
          .prepare(
            `SELECT f.id fileId, f.content_id contentId FROM files_fts JOIN files f ON f.id = files_fts.rowid
             WHERE files_fts MATCH ? AND f.status = 'linked' ORDER BY bm25(files_fts, 5.0, 1.0) LIMIT ?`
          )
          .all(match, K_NAME) as { fileId: number; contentId: number }[]).filter((n) => live.has(n.contentId))
      : []

    const vector = queryVec ? this.vectors.search(queryVec, K_VEC, (cid) => live.has(cid)) : []

    const fused = fuse({ keyword, keywordAll, vector, name })
    // Meaning search always returns nearest neighbours, however weak. Keep meaning-only results
    // only when they are close to the best match, so unrelated files don't pad the list.
    const margin = opts.vectorMargin ?? VECTOR_MARGIN
    const bestCos = vector[0]?.score ?? 0
    const ranked = [...fused.entries()]
      .filter(([, f]) => f.kwRank !== undefined || f.nameRank !== undefined || (f.bestCosine ?? -1) >= bestCos - margin)
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, MAX_RESULTS)

    const results: SearchResult[] = []
    for (const [contentId, f] of ranked) {
      const files = this.filesFor(contentId)
      if (!files.length) continue
      const content = this.db.prepare('SELECT title FROM contents WHERE id = ?').get(contentId) as { title: string | null }
      const bestChunks = [...f.chunkScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id)
      if (!bestChunks.length) {
        const first = this.db.prepare('SELECT id FROM chunks WHERE content_id = ? ORDER BY ord LIMIT 1').get(contentId) as { id: number } | undefined
        if (first) bestChunks.push(first.id)
      }
      const evidence = bestChunks.map((id) => this.evidence(id, terms)).filter((e): e is Evidence => !!e)
      const reasons: MatchReason[] = []
      const matched = this.matchedTerms(bestChunks, terms)
      if (matched.length) reasons.push({ kind: 'terms', terms: matched })
      if (f.vecRank !== undefined && f.vecRank <= 10) reasons.push({ kind: 'meaning', location: evidence[0]?.location })
      if (f.nameRank !== undefined) reasons.push({ kind: 'filename' })
      results.push({
        contentId,
        primary: files[0],
        copies: files.slice(1),
        title: content?.title ?? undefined,
        evidence,
        reasons,
        debug: { score: f.score, kwRank: f.kwRank, vecRank: f.vecRank, nameRank: f.nameRank, bestCosine: f.bestCosine }
      })
    }

    return { results, lowConfidence: this.isLowConfidence(results, terms, !!queryVec, opts.lowConfidenceCosine) }
  }

  /**
   * Plan doc 04 §6.5: low confidence when the top result covers under half the query terms, has weak
   * semantic similarity, and the two lists disagree. The cosine threshold is model-specific and was
   * calibrated on the eval set; a `lowConfidenceCosine` setting overrides it.
   */
  private isLowConfidence(results: SearchResult[], terms: string[], semantic: boolean, tauOverride?: number): boolean {
    if (!results.length) return false
    const top = results[0]
    const termReason = top.reasons.find((r) => r.kind === 'terms') as { terms: string[] } | undefined
    const coverage = terms.length ? (termReason?.terms.length ?? 0) / terms.length : 1
    if (!semantic) return coverage < 0.5
    const tauRow = this.db.prepare("SELECT value FROM settings WHERE key = 'lowConfidenceCosine'").get() as { value: string } | undefined
    const tau = tauOverride ?? (tauRow ? Number(tauRow.value) : DEFAULT_LOW_CONFIDENCE_COSINE)
    const agree = top.debug?.kwRank !== undefined && top.debug.kwRank <= 10 && top.debug?.vecRank !== undefined && top.debug.vecRank <= 10
    return coverage < 0.5 && (top.debug?.bestCosine ?? 0) < tau && !agree
  }

  private liveContents(): Set<number> {
    const rows = this.db.prepare("SELECT DISTINCT content_id id FROM files WHERE status = 'linked' AND content_id IS NOT NULL").all() as { id: number }[]
    return new Set(rows.map((r) => r.id))
  }

  filesFor(contentId: number): FileRef[] {
    return this.db
      .prepare(
        `SELECT x.id fileId, x.name, f.path || '\\' || x.rel_path path, f.path folderPath, x.ext, x.size, x.mtime_ms mtimeMs
         FROM files x JOIN folders f ON f.id = x.folder_id WHERE x.content_id = ? AND x.status = 'linked' ORDER BY x.mtime_ms DESC`
      )
      .all(contentId) as FileRef[]
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
    const { snippet, highlights } = makeSnippet(row.text, terms)
    return { chunkId, snippet, highlights, location: locationLabel(row.page_start, row.page_end, row.section_path) }
  }
}

export function locationLabel(pageStart: number | null, pageEnd: number | null, section: string | null): string | undefined {
  if (pageStart) return pageEnd && pageEnd !== pageStart ? `pp. ${pageStart}–${pageEnd}` : `p. ${pageStart}`
  if (section) return `§ ${section.split(' › ').slice(-1)[0]}`
  return undefined
}

/** Picks the window with the most matched terms; returns highlight offsets relative to the snippet. */
export function makeSnippet(text: string, terms: string[]): { snippet: string; highlights: HighlightRange[] } {
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
  return { snippet: prefix + body + suffix, highlights }
}
