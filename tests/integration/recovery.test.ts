import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, openDatabase } from '../../src/engine/db'
import { markCleanShutdown, readFolderList, removeIndexFiles, writeFolderList } from '../../src/engine/index-files'
import { IndexProblem, isCorruption, openIndex } from '../../src/engine/recovery'

const TMP_ROOT = path.resolve('tests/.tmp')
mkdirSync(TMP_ROOT, { recursive: true })
const root = mkdtempSync(path.join(TMP_ROOT, 'recovery-'))
let dir: string
let n = 0

beforeEach(() => {
  dir = path.join(root, String(n++))
  mkdirSync(dir)
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** An index with some real rows, closed cleanly. */
function makeIndex(rows = 400): void {
  const { db } = openIndex(dir)
  db.prepare("INSERT INTO folders(path, path_key, added_at) VALUES ('C:\\docs', 'c:\\docs', 0)").run()
  db.transaction(() => {
    const content = Number(db.prepare("INSERT INTO contents(sha256, kind, size, created_at) VALUES ('x', 'txt', 1, 0)").run().lastInsertRowid)
    const chunk = db.prepare('INSERT INTO chunks(content_id, ord, text, char_start, char_end) VALUES (?, ?, ?, 0, 10)')
    for (let i = 0; i < rows; i++) chunk.run(content, i, `passage ${i} about invoices and bookings `.repeat(20))
  })()
  db.close()
  markCleanShutdown(dir)
}

const problemOf = (fn: () => unknown) => {
  try {
    fn()
  } catch (err) {
    return err instanceof IndexProblem ? err.code : `not an IndexProblem: ${(err as Error).message}`
  }
  return 'no problem'
}

describe('opening the index', () => {
  it('checks integrity only after an unclean shutdown', () => {
    const first = openIndex(dir)
    expect(first.fresh).toBe(true)
    expect(first.checkMs).toBeUndefined()
    first.db.close()
    markCleanShutdown(dir)

    const clean = openIndex(dir)
    expect(clean.fresh).toBe(false)
    expect(clean.checkMs).toBeUndefined()
    clean.db.close() // no clean-shutdown marker this time, as after a crash

    const afterCrash = openIndex(dir)
    expect(afterCrash.checkMs).toBeGreaterThanOrEqual(0)
    afterCrash.db.close()
  })

  it('reports a file that is not a database as damaged', () => {
    writeFileSync(path.join(dir, 'recall.db'), 'this is not a database'.repeat(500))
    expect(problemOf(() => openIndex(dir))).toBe('damaged')
  })

  it('reports damaged pages found by the integrity check', () => {
    makeIndex()
    const file = path.join(dir, 'recall.db')
    const pages = statSync(file).size / 4096
    // Overwrite the middle of the file with garbage, as a failing disk might.
    const fd = openSync(file, 'r+')
    writeSync(fd, Buffer.alloc(4096 * 4, 0xa5), 0, 4096 * 4, 4096 * Math.floor(pages / 2))
    closeSync(fd)
    rmSync(path.join(dir, 'clean-shutdown')) // the check runs after an unclean shutdown
    expect(problemOf(() => openIndex(dir))).toBe('damaged')
  })

  it('refuses an index from a newer version', () => {
    makeIndex(1)
    const db = openDatabase(path.join(dir, 'recall.db'))
    db.pragma(`user_version = ${MIGRATIONS.length + 5}`)
    db.close()
    expect(problemOf(() => openIndex(dir))).toBe('newer_version')
  })

  it('restores the backup when an upgrade fails', () => {
    makeIndex()
    const failing = [...MIGRATIONS, 'CREATE TABLE extra(a); INSERT INTO no_such_table VALUES (1);']
    expect(problemOf(() => openIndex(dir, failing))).toBe('migration_failed')

    const db = openDatabase(path.join(dir, 'recall.db'))
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    expect(db.prepare('SELECT count(*) n FROM chunks').get()).toEqual({ n: 400 })
    expect(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name = 'extra'").get()).toEqual({ n: 0 })
    db.close()
    expect(readdirSync(dir).filter((f) => f.endsWith('.bak'))).toEqual([])
  })

  it('restores the backup when a later step of a multi-step upgrade fails', () => {
    makeIndex()
    const failing = [...MIGRATIONS, 'CREATE TABLE extra(a);', 'INSERT INTO no_such_table VALUES (1);']
    expect(problemOf(() => openIndex(dir, failing))).toBe('migration_failed')
    const db = openDatabase(path.join(dir, 'recall.db'))
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    expect(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name = 'extra'").get()).toEqual({ n: 0 })
    db.close()
  })

  it('upgrades, verifies and removes the backup when an upgrade succeeds', () => {
    makeIndex()
    const { db } = openIndex(dir, [...MIGRATIONS, 'CREATE TABLE extra(a);'])
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length + 1)
    expect(db.prepare('SELECT count(*) n FROM chunks').get()).toEqual({ n: 400 })
    db.close()
    expect(readdirSync(dir).filter((f) => f.endsWith('.bak'))).toEqual([])
  })

  it('recognises SQLite damage errors', () => {
    expect(isCorruption({ code: 'SQLITE_CORRUPT' })).toBe(true)
    expect(isCorruption({ code: 'SQLITE_CORRUPT_INDEX' })).toBe(true)
    expect(isCorruption({ code: 'SQLITE_NOTADB' })).toBe(true)
    expect(isCorruption({ code: 'SQLITE_BUSY' })).toBe(false)
    expect(isCorruption(new Error('x'))).toBe(false)
  })
})

describe('folder list and rebuild files', () => {
  it('round-trips the folder list and ignores a damaged one', () => {
    writeFolderList(dir, { folders: ['C:\\Users\\me\\Documents'], paused: true })
    expect(readFolderList(dir)).toEqual({ folders: ['C:\\Users\\me\\Documents'], paused: true })
    writeFileSync(path.join(dir, 'folders.json'), '{ not json')
    expect(readFolderList(dir)).toBeUndefined()
  })

  it('removes the index for a rebuild but keeps the folder list', () => {
    makeIndex(1)
    writeFolderList(dir, { folders: ['C:\\docs'], paused: false })
    removeIndexFiles(dir)
    expect(readdirSync(dir)).toEqual(['folders.json'])
    expect(existsSync(path.join(dir, 'recall.db'))).toBe(false)
    const reopened = openIndex(dir)
    expect(reopened.fresh).toBe(true)
    reopened.db.close()
  })
})
