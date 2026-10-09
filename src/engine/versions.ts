import type { DB } from './db'

// Plan doc 04 §6.4 (S4-04): near-duplicates and versions. Each content gets a MinHash signature over word
// 5-gram shingles; LSH bands find likely pairs cheaply; a pair is one family when the estimated Jaccard
// similarity is high and the file names agree once version markers ("v2", "final", "(1)", dates) are removed.

const HASHES = 128
const BANDS = 32 // 32 bands × 4 rows: pairs above ~0.45 Jaccard almost always share a band
const ROWS = HASHES / BANDS
const SHINGLE = 5

/**
 * When two contents are versions of one document. Short documents that were edited throughout share few
 * 5-word shingles (the fixture Acme versions: 0.14–0.25, unrelated files: 0.00), so the shared-text bar
 * drops as the names agree more. Tuned on the eval corpus's families and template look-alikes.
 */
export const VERSION_RULE = {
  /** Same name once version markers are removed, and some shared text… */
  sameName: 0.8,
  sameNameJaccard: 0.1,
  /** …but names that differ only by a date or year ("call-notes-2026-02-18") are usually a series: more text. */
  datedNameJaccard: 0.35,
  /** …or partly the same name and substantial shared text… */
  similarName: 0.5,
  similarNameJaccard: 0.4,
  /** …or nearly identical text, whatever the names. */
  jaccardAlone: 0.85
}

// Seeds for the 128 hash functions, from a fixed PRNG so signatures are stable across runs and versions.
const SEEDS = (() => {
  const out = new Uint32Array(HASHES)
  let s = 0x9e3779b9
  for (let i = 0; i < HASHES; i++) {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0
    out[i] = s
  }
  return out
})()

function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return h >>> 0
}

/** Murmur3 finalizer: a cheap, well-mixed 32-bit hash of x under seed. */
function mix(x: number, seed: number): number {
  let h = (x ^ seed) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

export function minhash(text: string): Uint32Array {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const shingles = new Set<number>()
  if (words.length < SHINGLE) shingles.add(fnv1a(words.join(' ')))
  for (let i = 0; i + SHINGLE <= words.length; i++) shingles.add(fnv1a(words.slice(i, i + SHINGLE).join(' ')))
  const sig = new Uint32Array(HASHES).fill(0xffffffff)
  for (const sh of shingles) {
    for (let k = 0; k < HASHES; k++) {
      const v = mix(sh, SEEDS[k])
      if (v < sig[k]) sig[k] = v
    }
  }
  return sig
}

/** Estimated Jaccard similarity of the two shingle sets. */
export function similarity(a: Uint32Array, b: Uint32Array): number {
  let same = 0
  for (let k = 0; k < HASHES; k++) if (a[k] === b[k]) same++
  return same / HASHES
}

function bands(sig: Uint32Array): number[] {
  const out: number[] = []
  for (let b = 0; b < BANDS; b++) {
    let h = 0x811c9dc5 ^ b
    for (let r = 0; r < ROWS; r++) h = Math.imul(h ^ sig[b * ROWS + r], 0x01000193)
    out.push(h | 0)
  }
  return out
}

const VERSION_WORDS = new Set(['v', 'ver', 'version', 'rev', 'revision', 'final', 'draft', 'copy', 'of', 'new', 'old', 'updated', 'latest', 'signed', 'clean', 'redline', 'edit', 'edited'])

const DATE = /(?<!\d)(?:\d{4}[-_.]?\d{2}[-_.]?\d{2}|(?:19|20)\d{2})(?!\d)/g

/** The dates and years in a file name, for telling a dated series apart from versions. */
export function nameDates(name: string): string[] {
  return name.replace(/\.[^.]+$/, '').match(DATE) ?? []
}

/** Words of a file name with version markers removed: "Copy of Acme_Proposal_v3 - final (2).docx" → acme, proposal. */
export function nameStem(name: string): string[] {
  const base = name
    .replace(/\.[^.]+$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(DATE, ' ') // dates and years
    .replace(/\(\d+\)/g, ' ') // "(1)" copies
    .replace(/[_-]+/g, ' ')
    .replace(/\bv(?:er(?:sion)?)?[\s.]*\d+(?:\.\d+)*\b/g, ' ') // v2, ver 3, version 1.2
    .replace(/\brev(?:ision)?[\s_.-]*\d+\b/g, ' ')
  // Other numbers stay: "sprint 12 retro" and "sprint 13 retro" are different documents, not versions.
  const words = base.match(/[\p{L}\p{N}]+/gu) ?? []
  return [...new Set(words.filter((w) => !VERSION_WORDS.has(w)))]
}

export function nameSimilarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0
  const sb = new Set(b)
  const both = a.filter((w) => sb.has(w)).length
  return both / (a.length + b.length - both)
}

/** Name similarity of two files, and whether their names differ only in dates or years. */
export function compareNames(a: string, b: string): { names: number; datesDiffer: boolean } {
  const da = nameDates(a).join(' ')
  const db = nameDates(b).join(' ')
  return { names: nameSimilarity(nameStem(a), nameStem(b)), datesDiffer: da !== db }
}

export function sameFamily(sim: number, names: { names: number; datesDiffer: boolean }, rule = VERSION_RULE): boolean {
  const sameNameBar = names.datesDiffer ? rule.datedNameJaccard : rule.sameNameJaccard
  return (
    (names.names >= rule.sameName && sim >= sameNameBar) ||
    (names.names >= rule.similarName && sim >= rule.similarNameJaccard) ||
    sim >= rule.jaccardAlone
  )
}

export function storeSignature(db: DB, contentId: number, text: string): void {
  const sig = minhash(text)
  const insertBand = db.prepare('INSERT OR IGNORE INTO content_bands(content_id, band, hash) VALUES (?, ?, ?)')
  db.transaction(() => {
    db.prepare('INSERT OR REPLACE INTO content_signatures(content_id, minhash) VALUES (?, ?)').run(contentId, Buffer.from(sig.buffer))
    db.prepare('DELETE FROM content_bands WHERE content_id = ?').run(contentId)
    bands(sig).forEach((h, b) => insertBand.run(contentId, b, h))
  })()
}

function signatureOf(db: DB, contentId: number): Uint32Array | undefined {
  const row = db.prepare('SELECT minhash FROM content_signatures WHERE content_id = ?').get(contentId) as { minhash: Buffer } | undefined
  if (!row) return undefined
  const copy = new Uint8Array(row.minhash)
  return new Uint32Array(copy.buffer, 0, HASHES)
}

/** The content's file name: its most recently modified linked file's. */
function nameOf(db: DB, contentId: number): string {
  const row = db
    .prepare("SELECT name FROM files WHERE content_id = ? AND status = 'linked' ORDER BY mtime_ms DESC LIMIT 1")
    .get(contentId) as { name: string } | undefined
  return row?.name ?? ''
}

/**
 * Version families of the given contents: for each, the other contents in its family (any linked content,
 * not only the given ones). Families are closed transitively, so v1–v2 and v2–v3 make one family.
 */
export function versionFamilies(db: DB, contentIds: number[]): Map<number, number[]> {
  const parent = new Map<number, number>()
  const find = (x: number): number => {
    let r = x
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!
    parent.set(x, r)
    return r
  }
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb))
  }
  // Two ways to find candidates: LSH bands catch near-identical text whatever the names; versions edited
  // throughout share too little text for LSH, but their names agree, so the file-name index finds those.
  const byBands = db.prepare(
    `SELECT DISTINCT o.content_id id FROM content_bands m JOIN content_bands o ON o.band = m.band AND o.hash = m.hash
     WHERE m.content_id = ? AND o.content_id <> m.content_id
       AND EXISTS (SELECT 1 FROM files x WHERE x.content_id = o.content_id AND x.status = 'linked')`
  )
  const byName = db.prepare(
    `SELECT DISTINCT x.content_id id FROM files_fts JOIN files x ON x.id = files_fts.rowid
     WHERE files_fts MATCH ? AND x.status = 'linked' AND x.content_id IS NOT NULL AND x.content_id <> ? LIMIT 50`
  )
  const candidates = {
    all: (id: number): { id: number }[] => {
      const words = stem(id)
      const named = words.length
        ? (byName.all(`name_tokens : (${words.map((w) => `"${w.replace(/"/g, '""')}"`).join(' AND ')})`, id) as { id: number }[])
        : []
      return [...(byBands.all(id) as { id: number }[]), ...named]
    }
  }
  const sigs = new Map<number, Uint32Array | undefined>()
  const names = new Map<number, string>()
  const sig = (id: number) => (sigs.has(id) ? sigs.get(id) : sigs.set(id, signatureOf(db, id)).get(id))
  const name = (id: number) => names.get(id) ?? names.set(id, nameOf(db, id)).get(id)!
  const stem = (id: number) => nameStem(name(id))

  // Expand outwards from the given contents so chains (v1–v2–v3) are found even if v1 alone matched.
  const queue = [...new Set(contentIds)]
  const seen = new Set(queue)
  for (let i = 0; i < queue.length && i < 500; i++) {
    const id = queue[i]
    const a = sig(id)
    if (!a) continue
    parent.set(id, parent.get(id) ?? id)
    for (const { id: other } of candidates.all(id) as { id: number }[]) {
      const b = sig(other)
      if (!b || !sameFamily(similarity(a, b), compareNames(name(id), name(other)))) continue
      parent.set(other, parent.get(other) ?? other)
      union(id, other)
      if (!seen.has(other)) {
        seen.add(other)
        queue.push(other)
      }
    }
  }
  const members = new Map<number, number[]>()
  for (const id of parent.keys()) {
    const root = find(id)
    members.set(root, [...(members.get(root) ?? []), id])
  }
  const out = new Map<number, number[]>()
  for (const id of contentIds) {
    const family = parent.has(id) ? members.get(find(id)) ?? [] : []
    out.set(id, family.filter((m) => m !== id))
  }
  return out
}
