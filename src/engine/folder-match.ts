// Folder requests by voice ("find my tax folder", plan 12 D-20): match the words against the names of folders that
// hold indexed files. Pure, so the scoring is unit-tested; the folder list comes from the index, never from speech.

const STOP = new Set(['the', 'a', 'an', 'my', 'our', 'of', 'for', 'with', 'and', 'in', 'on', 'to', 'from', 'about', 'all', 'some', 'stuff', 'things'])

const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))

/** "Recipes" matches "recipe", "Taxes" matches "tax": plural endings are ignored. */
const stem = (w: string) => w.replace(/(ies)$/, 'y').replace(/(es|s)$/, '')

export interface FolderMatch {
  path: string
  name: string
  score: number
}

export function matchFolders(query: string, dirs: Iterable<string>, limit = 5): FolderMatch[] {
  const q = words(query).map(stem)
  if (!q.length) return []
  const out: FolderMatch[] = []
  for (const dir of dirs) {
    const name = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? dir
    const n = words(name).map(stem)
    if (!n.length) continue
    let score = 0
    for (const w of q) {
      if (n.includes(w)) score += 2
      else if (w.length >= 3 && n.some((x) => x.startsWith(w) || w.startsWith(x))) score += 1
    }
    if (score > 0) out.push({ path: dir, name, score })
  }
  // Best score first; then the shallower folder ("Taxes" before "Taxes\2023"); then by name.
  return out
    .sort((a, b) => b.score - a.score || depth(a.path) - depth(b.path) || a.path.localeCompare(b.path))
    .slice(0, limit)
}

const depth = (p: string) => p.split(/[\\/]/).length

/** Every folder from each added root down to each indexed file's parent. */
export function foldersOf(rows: Iterable<{ root: string; rel: string }>): Set<string> {
  const dirs = new Set<string>()
  for (const { root, rel } of rows) {
    const base = root.replace(/[\\/]+$/, '')
    dirs.add(base)
    const parts = rel.split(/[\\/]/)
    parts.pop()
    let cur = base
    for (const p of parts) {
      cur = `${cur}\\${p}`
      dirs.add(cur)
    }
  }
  return dirs
}
