import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// Files in the data folder around the index. No database access here, so main can use it too.

export const DB_FILE = 'recall.db'
export const CLEAN_SHUTDOWN = 'clean-shutdown'
export const CHECK_NEXT_START = 'check-index'
const FOLDERS_FILE = 'folders.json'

/** Called after the database is closed on a normal shutdown; its absence on the next start triggers the check. */
export function markCleanShutdown(dir: string): void {
  writeFileSync(path.join(dir, CLEAN_SHUTDOWN), '')
}

/** Called when SQLite reports damage while running; the next start checks the index. */
export function markCheckNextStart(dir: string): void {
  try {
    writeFileSync(path.join(dir, CHECK_NEXT_START), '')
  } catch {
    // Without the marker the missing clean-shutdown file still triggers the check.
  }
}

/** Removes the index for a rebuild. Keeps the folder list, so the new index starts from the same folders. */
export function removeIndexFiles(dir: string): void {
  for (const name of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`, CLEAN_SHUTDOWN, CHECK_NEXT_START]) {
    rmSync(path.join(dir, name), { force: true })
  }
}

export interface FolderList {
  folders: string[]
  paused: boolean
}

/** Written whenever folders change; replaced atomically so a crash never leaves half a file. */
export function writeFolderList(dir: string, list: FolderList): void {
  const file = path.join(dir, FOLDERS_FILE)
  writeFileSync(file + '.tmp', JSON.stringify({ version: 1, ...list }, null, 2))
  renameSync(file + '.tmp', file)
}

export function readFolderList(dir: string): FolderList | undefined {
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, FOLDERS_FILE), 'utf8')) as Partial<FolderList>
    if (!Array.isArray(raw.folders)) return undefined
    return { folders: raw.folders.filter((f): f is string => typeof f === 'string'), paused: raw.paused === true }
  } catch {
    return undefined
  }
}
