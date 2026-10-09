import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/engine/db'
import { TopK, VectorIndex, vecToBuffer } from '../../src/engine/vectors'
import { EMBED_DIMS } from '../../src/shared/constants'

function vec(seed: number): Float32Array {
  const v = new Float32Array(EMBED_DIMS)
  let n = 0
  for (let i = 0; i < EMBED_DIMS; i++) {
    v[i] = Math.sin(seed * 12.9898 + i * 78.233)
    n += v[i] * v[i]
  }
  for (let i = 0; i < EMBED_DIMS; i++) v[i] /= Math.sqrt(n)
  return v
}

function bruteForce(vectors: Map<number, Float32Array>, q: Float32Array, k: number) {
  return [...vectors.entries()]
    .map(([id, v]) => ({ id, score: v.reduce((s, x, i) => s + x * q[i], 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((r) => r.id)
}

describe('TopK', () => {
  it('keeps the k highest scores in descending order', () => {
    const top = new TopK(3)
    ;[5, 1, 9, 3, 7, 9.5, 0].forEach((s, i) => top.offer(i, s))
    expect(top.sorted().map((x) => x.score)).toEqual([9.5, 9, 7])
  })
})

describe('VectorIndex', () => {
  const setup = () => {
    const db = openDatabase(':memory:')
    const vectors = new Map<number, Float32Array>()
    for (let c = 1; c <= 4; c++) db.prepare("INSERT INTO contents(id, sha256, kind, size, created_at) VALUES (?, ?, 'text', 0, 0)").run(c, `h${c}`)
    for (let id = 1; id <= 40; id++) {
      const v = vec(id)
      vectors.set(id, v)
      db.prepare("INSERT INTO chunks(id, content_id, ord, text, char_start, char_end) VALUES (?, ?, ?, '', 0, 0)").run(id, ((id - 1) % 4) + 1, id)
      db.prepare('INSERT INTO chunk_vectors(chunk_id, vec) VALUES (?, ?)').run(id, vecToBuffer(v))
    }
    return { db, vectors }
  }

  it('matches brute-force exact search', () => {
    const { db, vectors } = setup()
    const index = new VectorIndex(db)
    const q = vec(1000)
    expect(index.search(q, 10).map((h) => h.chunkId)).toEqual(bruteForce(vectors, q, 10))
  })

  it('removes contents in place, equal to a fresh reload', () => {
    const { db, vectors } = setup()
    const index = new VectorIndex(db)
    expect(index.size).toBe(40)
    db.prepare('DELETE FROM contents WHERE id IN (2, 3)').run()
    index.removeContents(new Set([2, 3]))
    for (const id of [...vectors.keys()]) if ([2, 3].includes(((id - 1) % 4) + 1)) vectors.delete(id)
    expect(index.size).toBe(20)
    const q = vec(7)
    const inPlace = index.search(q, 15).map((h) => h.chunkId)
    expect(inPlace).toEqual(bruteForce(vectors, q, 15))
    expect(inPlace).toEqual(new VectorIndex(db).search(q, 15).map((h) => h.chunkId))
  })
})
