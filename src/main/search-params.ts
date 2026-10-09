// Validation for the search and document parameters the renderer sends. Anything unexpected is dropped.
import type { SearchFilters, TypeFilter } from '../shared/types'

const TYPES: readonly TypeFilter[] = ['pdf', 'docx', 'notes', 'code', 'images']
const MAX_DATE = 8.64e15
const MAX_PASSAGES = 10

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const nonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0

export function searchFilters(v: unknown): SearchFilters {
  if (!isRecord(v)) return {}
  const out: SearchFilters = {}
  if (TYPES.includes(v.type as TypeFilter)) out.type = v.type as TypeFilter
  if (nonNegInt(v.folderId)) out.folderId = v.folderId
  const m = v.modified
  if (isRecord(m) && typeof m.from === 'number' && typeof m.to === 'number' && m.from >= 0 && m.to <= MAX_DATE && m.from < m.to) {
    out.modified = { from: m.from, to: m.to, label: String(m.label ?? '').slice(0, 60) }
  }
  if (v.ignoreTemporal === true) out.ignoreTemporal = true
  return out
}

export function passageRefs(v: unknown): { chunkId: number; start: number; end: number }[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((p): p is Record<string, unknown> => isRecord(p) && nonNegInt(p.chunkId) && nonNegInt(p.start) && nonNegInt(p.end) && p.start <= p.end)
    .slice(0, MAX_PASSAGES)
    .map((p) => ({ chunkId: p.chunkId as number, start: p.start as number, end: p.end as number }))
}
