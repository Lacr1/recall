// Example searches for the empty search screen, built from the user's own recently changed files so the
// examples point at things they actually have. No model involved: distinctive words are picked by tf-idf
// against the full-text index, then dropped into a short template.
import type { DB } from './db'
import type { Kind } from './paths'
import { ftsQuery } from './search'
import { queryTerms } from '../shared/text'

const POOL_PER_KIND = 15
const SAMPLE_CHUNKS = 12
const CANDIDATE_WORDS = 30
// Document frequency is only needed to tell rare words from common ones, so counting stops here.
const DF_CAP = 200
const PROPER_NOUN_BOOST = 1.5

// Words in a file name or title that say what kind of file it is, and the noun used in the example.
const FILE_NOUNS: Record<string, string> = {
  proposal: 'proposal', invoice: 'invoice', contract: 'contract', agreement: 'agreement', receipt: 'receipt',
  manual: 'manual', statement: 'statement', itinerary: 'itinerary', recipe: 'recipe', resume: 'resume', cv: 'resume',
  report: 'report', budget: 'budget', quote: 'quote', letter: 'letter', guide: 'guide', policy: 'policy',
  checklist: 'checklist', spec: 'spec', brief: 'brief', plan: 'plan', planning: 'plan', presentation: 'presentation',
  notes: 'notes', note: 'notes', retro: 'notes', minutes: 'notes', journal: 'notes'
}

// Files nobody wrote themselves (licences, changelogs, vendored and generated code) make poor examples.
const BOILERPLATE_NAME = /(^|[._-])(license|licence|copying|notice|changelog|changes|history|authors|contributing|code_of_conduct|security|third[_-]?party)([._-]|$)/i
const BOILERPLATE_DIR = /(^|[\\/:])(node_modules|vendor|third[_-]?party|dist|build|out|\.git|\.next|coverage)([\\/]|$)/i

const COMMON = new Set(
  ('also after again against almost along already although always among another anyone anything around back because been ' +
    'before being below between both cannot could down during each either else enough even ever every first following ' +
    'further gets getting give given goes going good great having here hers herself himself however into itself just keep ' +
    'last least less like likely made make makes making many maybe might more most much must need needs never next none ' +
    'nothing often once only onto other others otherwise over part perhaps please quite rather really said same says seem ' +
    'seems several shall should since some something soon still such sure take than thank thanks thing things think though ' +
    'through thus till toward under until upon used uses using very want well went whatever whether while whom whose within ' +
    'without would page pages http https const function return import export true false null undefined async await class ' +
    'interface type string number boolean void public private static elif self require module default extends implements ' +
    'today tomorrow yesterday week weeks weekly month months year years hour hours minute minutes morning evening night ' +
    'monday tuesday wednesday thursday friday saturday sunday january february march april june july august september ' +
    'october november december').split(' ')
)

export interface SearchSuggestion {
  query: string
  contentId: number
}

interface Candidate {
  contentId: number
  kind: Kind
  title: string | null
  name: string
  dir: string
}

/** Up to `limit` example searches, each built from a different recently changed file. */
export function searchSuggestions(db: DB, limit = 3): SearchSuggestion[] {
  // The newest files of each kind, so a busy code project doesn't crowd out documents and notes.
  const pool = db
    .prepare(
      `SELECT contentId, kind, title, name, folderId, relPath FROM (
         SELECT c.id contentId, c.kind, c.title, x.name, x.folder_id folderId, x.rel_path relPath, max(x.mtime_ms) mtime,
                row_number() OVER (PARTITION BY c.kind ORDER BY max(x.mtime_ms) DESC) n
         FROM contents c JOIN files x ON x.content_id = c.id
         WHERE x.status = 'linked' AND c.extract_status = 'ok' AND c.chunk_count > 0
         GROUP BY c.id
       ) WHERE n <= ? ORDER BY kind = 'code', mtime DESC`
    )
    .all(POOL_PER_KIND) as (Omit<Candidate, 'dir'> & { folderId: number; relPath: string })[]
  const candidates: Candidate[] = pool.map((r) => ({
    ...r,
    dir: `${r.folderId}:${r.relPath.slice(0, Math.max(r.relPath.lastIndexOf('\\'), r.relPath.lastIndexOf('/'), 0))}`
  }))

  const totalChunks = (db.prepare('SELECT count(*) n FROM chunks').get() as { n: number }).n
  const dfStmt = db.prepare(`SELECT count(*) n FROM (SELECT 1 FROM chunks_fts WHERE chunks_fts MATCH ? LIMIT ${DF_CAP})`)
  const df = (word: string) => (dfStmt.get(ftsQuery([word])) as { n: number }).n

  const out: SearchSuggestion[] = []
  const usedDirs = new Set<string>()
  const usedKinds = new Set<Kind>()
  // Each pass relaxes the variety rules: first one file per kind and per folder, then one per folder (still at
  // most one code file), then anything left.
  for (const pass of [0, 1, 2]) {
    for (const c of candidates) {
      if (out.length >= limit) return out
      if (out.some((s) => s.contentId === c.contentId) || BOILERPLATE_NAME.test(c.name) || BOILERPLATE_DIR.test(c.dir)) continue
      if (pass < 2 && (usedDirs.has(c.dir) || (c.kind === 'code' && usedKinds.has('code')))) continue
      if (pass < 1 && usedKinds.has(c.kind)) continue
      const query = phrase(db, c, totalChunks, df)
      if (!query) continue
      out.push({ query, contentId: c.contentId })
      usedDirs.add(c.dir)
      usedKinds.add(c.kind)
    }
  }
  return out
}

function phrase(db: DB, c: Candidate, totalChunks: number, df: (word: string) => number): string | undefined {
  // The file's own name and title say what it is best; its folder names ("recipes", "invoices") are next.
  const hints = queryTerms(`${c.name.replace(/\.[^.]+$/, '')} ${c.title ?? ''} ${c.dir.split(':')[1].split(/[\\/]/).reverse().join(' ')}`)
  const noun = hints.map((w) => FILE_NOUNS[w] ?? FILE_NOUNS[w.replace(/s$/, '')]).find(Boolean)

  const text = (db.prepare('SELECT text FROM chunks WHERE content_id = ? ORDER BY ord LIMIT ?').all(c.contentId, SAMPLE_CHUNKS) as { text: string }[])
    .map((r) => r.text)
    .join('\n')
  const terms = distinctiveTerms(text, totalChunks, df).filter((t) => !noun || !t.keys.some((k) => FILE_NOUNS[k] === noun))
  const [a, b] = pickPair(terms)
  if (!a || !b) return undefined

  if (c.kind === 'code') return `code for ${a} and ${b}`
  if (noun) return `${noun} about ${a} and ${b}`
  if (c.kind === 'pdf') return `the PDF about ${a} and ${b}`
  if (c.kind === 'docx') return `the document about ${a} and ${b}`
  return `notes about ${a} and ${b}`
}

interface Term {
  text: string
  keys: string[]
  score: number
}

interface Tally {
  tf: number
  forms: Map<string, number>
}

/**
 * Words, and two-word phrases seen more than once ("inlet hose"), that are frequent in this file but rare
 * across the index, in the spelling the file uses most.
 */
function distinctiveTerms(text: string, totalChunks: number, df: (word: string) => number): Term[] {
  const tokens: { key: string; form: string; start: number; end: number }[] = []
  const words = new Map<string, Tally>()
  // Capitalised mid-sentence: a name (a client, a place, a product), which people remember well.
  const properNouns = new Set<string>()
  // Plain words only: lower-case or Capitalised, so code identifiers, acronyms and numbers are left out.
  for (const m of text.matchAll(/(?<![\p{L}\p{N}_])(?:\p{Lu}\p{Ll}{3,17}|\p{Ll}{4,18})(?![\p{L}\p{N}_])/gu)) {
    const key = m[0].toLowerCase()
    if (COMMON.has(key) || !queryTerms(key).length) continue
    tokens.push({ key, form: m[0], start: m.index, end: m.index + m[0].length })
    tally(words, key, m[0])
    if (/^\p{Lu}/u.test(m[0]) && /[\p{Ll},] $/u.test(text.slice(m.index - 2, m.index))) properNouns.add(key)
  }

  const idf = new Map<string, number>()
  for (const [key] of [...words.entries()].sort((x, y) => y[1].tf - x[1].tf).slice(0, CANDIDATE_WORDS)) {
    idf.set(key, Math.log((totalChunks + 1) / (df(key) + 1)))
  }

  const phrases = new Map<string, Tally>()
  for (let i = 0; i + 1 < tokens.length; i++) {
    const [t, u] = [tokens[i], tokens[i + 1]]
    if (u.start === t.end + 1 && text[t.end] === ' ' && t.key !== u.key && idf.has(t.key) && idf.has(u.key)) {
      tally(phrases, `${t.key} ${u.key}`, `${t.form} ${u.form}`)
    }
  }

  const terms: Term[] = []
  for (const [key, e] of words) {
    if (idf.has(key)) terms.push({ text: commonest(e), keys: [key], score: e.tf * idf.get(key)! * (properNouns.has(key) ? PROPER_NOUN_BOOST : 1) })
  }
  for (const [key, e] of phrases) {
    const keys = key.split(' ')
    if (e.tf >= 2) terms.push({ text: commonest(e), keys, score: e.tf * (idf.get(keys[0])! + idf.get(keys[1])!) })
  }
  return terms.filter((t) => t.score > 0).sort((x, y) => y.score - x.score)
}

function tally(map: Map<string, Tally>, key: string, form: string): void {
  const e = map.get(key) ?? { tf: 0, forms: new Map() }
  e.tf++
  e.forms.set(form, (e.forms.get(form) ?? 0) + 1)
  map.set(key, e)
}

function commonest(e: Tally): string {
  return [...e.forms.entries()].sort((x, y) => y[1] - x[1])[0][0]
}

/** The two best terms that share no word, counting forms of a word as the same ("payment" / "payments"). */
function pickPair(terms: Term[]): [string?, string?] {
  const a = terms[0]
  if (!a) return []
  const same = (x: string, y: string) => {
    const n = Math.min(5, x.length, y.length)
    return x.slice(0, n) === y.slice(0, n)
  }
  const b = terms.find((t) => !t.keys.some((k) => a.keys.some((j) => same(k, j))))
  return [a.text, b?.text]
}
