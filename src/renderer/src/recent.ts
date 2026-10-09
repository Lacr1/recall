// Recent searches, kept in this window's local storage. "Delete all data" clears it with the rest of the
// browser storage. Storage can be unavailable or throw, so every access is guarded.
import { MAX_RECENT, withRecent } from '../../shared/recent'

const KEY = 'recall.recentSearches'

export function loadRecent(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(list) ? list.filter((q): q is string => typeof q === 'string').slice(0, MAX_RECENT) : []
  } catch {
    return []
  }
}

function save(list: string[]): string[] {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    // Not kept for next time; still shown this session.
  }
  return list
}

export const addRecent = (list: string[], query: string) => save(withRecent(list, query))
export const removeRecent = (list: string[], query: string) => save(list.filter((r) => r !== query))
export const clearRecent = () => save([])
