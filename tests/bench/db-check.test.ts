import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { openDatabase } from '../../src/engine/db'
import { EMBED_DIMS } from '../../src/shared/constants'

// S3-04: how long SQLite's startup integrity check takes on realistic index sizes, to set its time budget.
const SIZES = [10_000, 50_000, 100_000]
const TMP_ROOT = path.resolve('tests/.tmp')
mkdirSync(TMP_ROOT, { recursive: true })
const dir = mkdtempSync(path.join(TMP_ROOT, 'dbcheck-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

it('measures quick_check and integrity_check time by index size', () => {
  const rows: string[] = ['| Chunks | DB size | quick_check | integrity_check |', '|---|---|---|---|']
  const words = 'invoice proposal payment booking warranty authentication meeting schedule review project client budget'.split(' ')
  for (const n of SIZES) {
    const file = path.join(dir, `idx-${n}.db`)
    const db = openDatabase(file)
    const vec = Buffer.alloc(EMBED_DIMS * 4, 7)
    db.transaction(() => {
      const content = db.prepare("INSERT INTO contents(sha256, kind, size, created_at, extract_status, embed_status) VALUES (?, 'txt', 1, 0, 'ok', 'done')")
      const chunk = db.prepare('INSERT INTO chunks(content_id, ord, text, char_start, char_end) VALUES (?, ?, ?, 0, 1200)')
      const v = db.prepare('INSERT INTO chunk_vectors(chunk_id, vec) VALUES (?, ?)')
      let contentId = 0
      for (let i = 0; i < n; i++) {
        if (i % 8 === 0) contentId = Number(content.run(`sha-${i}`).lastInsertRowid)
        let text = ''
        while (text.length < 1200) text += words[(i * 7 + text.length) % words.length] + ' ' + (i % 997) + ' '
        const id = Number(chunk.run(contentId, i % 8, text).lastInsertRowid)
        v.run(id, vec)
      }
    })()
    db.pragma('wal_checkpoint(TRUNCATE)')
    const size = statSync(file).size
    const time = (sql: string) => {
      const t = performance.now()
      expect(db.pragma(sql, { simple: true })).toBe('ok')
      return performance.now() - t
    }
    time('quick_check') // warm the OS file cache, as on a normal start
    const quick = time('quick_check')
    const full = time('integrity_check')
    db.close()
    rows.push(`| ${n.toLocaleString('en')} | ${(size / 1e6).toFixed(0)} MB | ${quick.toFixed(0)} ms | ${full.toFixed(0)} ms |`)
  }
  mkdirSync('eval-results', { recursive: true })
  writeFileSync('eval-results/bench-db-check.md', rows.join('\n') + '\n')
  console.log(rows.join('\n'))
})
