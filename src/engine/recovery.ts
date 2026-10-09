import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { MIGRATIONS, openDatabase, type DB } from './db'
import { CHECK_NEXT_START, CLEAN_SHUTDOWN, DB_FILE } from './index-files'
import type { IndexProblemCode } from '../shared/types'

// Recovery (plan S3-04, doc 02 §5.13): the index is derived data, so when it can't be used Recall offers to
// rebuild it from the user's folders (see index-files.ts for the folder list kept outside the database).

export class IndexProblem extends Error {
  constructor(
    readonly code: IndexProblemCode,
    message: string
  ) {
    super(message)
  }
}

/** SQLite reports damage as SQLITE_CORRUPT (and variants) or SQLITE_NOTADB. */
export function isCorruption(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code
  return typeof code === 'string' && (code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB')
}

export interface OpenedIndex {
  db: DB
  /** No database existed before this start. */
  fresh: boolean
  /** Duration of the integrity check, if one ran. */
  checkMs?: number
}

/**
 * Opens the index. The integrity check (about 11 ms per 1,000 passages) runs only when the last session did not
 * shut down cleanly or SQLite reported damage, so normal starts stay fast. Throws IndexProblem when the index
 * can't be used.
 */
export function openIndex(dir: string, migrations: string[] = MIGRATIONS): OpenedIndex {
  const file = path.join(dir, DB_FILE)
  const fresh = !existsSync(file)
  const needCheck = !fresh && (!existsSync(path.join(dir, CLEAN_SHUTDOWN)) || existsSync(path.join(dir, CHECK_NEXT_START)))
  rmSync(path.join(dir, CLEAN_SHUTDOWN), { force: true })

  let db: DB
  try {
    db = openDatabase(file, migrations)
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'DB_NEWER_VERSION') throw new IndexProblem('newer_version', 'This index was made by a newer version of Recall.')
    if (code === 'DB_MIGRATION_FAILED') throw new IndexProblem('migration_failed', (err as Error).message)
    if (isCorruption(err)) throw new IndexProblem('damaged', 'The index file is damaged.')
    throw new IndexProblem('cannot_open', `Recall can't open its index: ${(err as Error).message}`)
  }

  let checkMs: number | undefined
  if (needCheck) {
    const t0 = performance.now()
    let ok = false
    try {
      ok = db.pragma('quick_check', { simple: true }) === 'ok'
    } catch (err) {
      if (!isCorruption(err)) {
        db.close()
        throw err
      }
    }
    checkMs = Math.round(performance.now() - t0)
    if (!ok) {
      db.close()
      throw new IndexProblem('damaged', 'The index file is damaged.')
    }
  }
  rmSync(path.join(dir, CHECK_NEXT_START), { force: true })
  return { db, fresh, checkMs }
}
