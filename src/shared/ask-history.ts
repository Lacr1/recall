import type { AskSource } from './types'

export const MAX_ASK_HISTORY = 50

/** A finished question and its answer, kept so it can be read again without asking the model. */
export interface AskHistoryEntry {
  id: string
  question: string
  answer: string
  sources: AskSource[]
  insufficient: boolean
  invalidCitations: number[]
  model: string
  at: number
}

/** The history with `entry` first, capped at MAX_ASK_HISTORY. */
export function withAskEntry(list: AskHistoryEntry[], entry: AskHistoryEntry): AskHistoryEntry[] {
  return [entry, ...list.filter((e) => e.id !== entry.id)].slice(0, MAX_ASK_HISTORY)
}

/** Reads stored history, dropping anything that isn't a well-formed entry. */
export function parseAskHistory(json: string | null): AskHistoryEntry[] {
  let list: unknown
  try {
    list = JSON.parse(json ?? '[]')
  } catch {
    return []
  }
  return Array.isArray(list) ? list.filter(isEntry).slice(0, MAX_ASK_HISTORY) : []
}

function isEntry(e: unknown): e is AskHistoryEntry {
  if (!e || typeof e !== 'object') return false
  const x = e as Record<string, unknown>
  return (
    typeof x.id === 'string' &&
    typeof x.question === 'string' &&
    typeof x.answer === 'string' &&
    Array.isArray(x.sources) &&
    x.sources.every(isSource) &&
    typeof x.insufficient === 'boolean' &&
    Array.isArray(x.invalidCitations) &&
    x.invalidCitations.every((n) => typeof n === 'number') &&
    typeof x.model === 'string' &&
    typeof x.at === 'number'
  )
}

function isSource(s: unknown): s is AskSource {
  if (!s || typeof s !== 'object') return false
  const x = s as Record<string, unknown>
  return (
    typeof x.n === 'number' &&
    typeof x.fileId === 'number' &&
    typeof x.name === 'string' &&
    (x.location === undefined || typeof x.location === 'string') &&
    typeof x.snippet === 'string'
  )
}
