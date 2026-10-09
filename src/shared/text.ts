import type { HighlightRange } from './types'

const STOPWORDS = new Set(
  ('a an and are as at be by did do does for from had has have how i in is it its me my of on or our that the their them ' +
    'then there these this those to was we were what when where which who why will with you your find show file files ' +
    'document documents doc docs about').split(' ')
)

/** Lower-cased, de-duplicated content words of a query (numbers kept, e.g. "50" from "50%"). */
export function queryTerms(q: string): string[] {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return [...new Set(words.filter((w) => !STOPWORDS.has(w) && (w.length > 1 || /\d/.test(w))))]
}

/** Occurrences of a term as a word prefix, so "payment" also matches "payments". */
export function findTerm(text: string, term: string): HighlightRange[] {
  const out: HighlightRange[] = []
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(term)}[\\p{L}\\p{N}]*`, 'giu')
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ start: m.index, end: m.index + m[0].length })
  return out
}

export function findTerms(text: string, terms: string[]): HighlightRange[] {
  const hits = terms.flatMap((t) => findTerm(text, t)).sort((a, b) => a.start - b.start)
  const out: HighlightRange[] = []
  for (const h of hits) {
    const last = out[out.length - 1]
    if (last && h.start <= last.end) last.end = Math.max(last.end, h.end)
    else out.push({ ...h })
  }
  return out
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
