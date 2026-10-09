// Past questions and answers, kept in this window's local storage. "Delete all data" clears it with the rest of
// the browser storage. Storage can be unavailable or throw, so every access is guarded.
import { parseAskHistory, withAskEntry, type AskHistoryEntry } from '../../shared/ask-history'

const KEY = 'recall.askHistory'

export function loadAskHistory(): AskHistoryEntry[] {
  try {
    return parseAskHistory(localStorage.getItem(KEY))
  } catch {
    return []
  }
}

function save(list: AskHistoryEntry[]): AskHistoryEntry[] {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    // Not kept for next time; still shown this session.
  }
  return list
}

export const addAskEntry = (list: AskHistoryEntry[], entry: AskHistoryEntry) => save(withAskEntry(list, entry))
export const removeAskEntry = (list: AskHistoryEntry[], id: string) => save(list.filter((e) => e.id !== id))
export const clearAskHistory = () => save([])
