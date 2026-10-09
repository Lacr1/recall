export const MAX_RECENT = 5

/**
 * The recent-search list with `query` first. Earlier entries it extends are dropped, so a search typed in
 * pauses ("proposal", then "proposal 50%") leaves only the finished one.
 */
export function withRecent(list: string[], query: string): string[] {
  const q = query.trim()
  if (!q) return list
  const lower = q.toLowerCase()
  return [q, ...list.filter((r) => !lower.startsWith(r.toLowerCase()))].slice(0, MAX_RECENT)
}
