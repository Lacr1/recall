import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertIndexConsistent, MIGRATIONS, openDatabase } from '../../src/engine/db'
import { activeSpace } from '../../src/engine/spaces'

const TMP = path.resolve('tests/.tmp')
let dir: string

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('index format v2: embedding spaces (S4-07)', () => {
  it('moves the vectors of an existing v1 index into the nomic-embed-text space', () => {
    mkdirSync(TMP, { recursive: true })
    dir = mkdtempSync(path.join(TMP, 'migrate-'))
    const file = path.join(dir, 'recall.db')
    const v1 = openDatabase(file, MIGRATIONS.slice(0, 1))
    v1.prepare("INSERT INTO contents(id, sha256, kind, size, created_at, extract_status, embed_status, chunk_count) VALUES (1, 'h', 'text', 1, 0, 'ok', 'done', 1)").run()
    v1.prepare("INSERT INTO chunks(id, content_id, ord, text, char_start, char_end) VALUES (7, 1, 0, 'hello', 0, 5)").run()
    v1.prepare('INSERT INTO chunk_vectors(chunk_id, vec) VALUES (7, ?)').run(Buffer.alloc(768 * 4, 1))
    v1.close()

    const db = openDatabase(file)
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    expect(activeSpace(db)).toMatchObject({ id: 1, model: 'nomic-embed-text', dims: 768, docPrefix: 'search_document: ', lowConfidenceCosine: 0.6 })
    expect(db.prepare('SELECT space_id, chunk_id, length(vec) len FROM chunk_vectors').all()).toEqual([{ space_id: 1, chunk_id: 7, len: 768 * 4 }])
    assertIndexConsistent(db)
    // Deleting the chunk still removes its vector.
    db.prepare('DELETE FROM chunks WHERE id = 7').run()
    expect(db.prepare('SELECT count(*) n FROM chunk_vectors').get()).toEqual({ n: 0 })
    db.close()
  })
})
