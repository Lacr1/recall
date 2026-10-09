import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/engine/db'
import { TopK, VectorIndex, vecToBuffer } from '../../src/engine/vectors'
import { EMBED_DIMS } from '../../src/shared/constants'

function vec(seed: number, dims = EMBED_DIMS): Float32Array {
  const v = new Float32Array(dims)
  let n = 0
  for (let i = 0; i < dims; i++) {
    v[i] = Math.sin(seed * 12.9898 + i * 78.233)
    n += v[i] * v[i]
  }
  for (let i = 0; i < dims; i++) v[i] /= Math.sqrt(n)
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

const setup = (count = 40, dims = EMBED_DIMS) => {
  const db = openDatabase(':memory:')
  const vectors = new Map<number, Float32Array>()
  for (let c = 1; c <= 4; c++) db.prepare("INSERT INTO contents(id, sha256, kind, size, created_at) VALUES (?, ?, 'text', 0, 0)").run(c, `h${c}`)
  for (let id = 1; id <= count; id++) {
    const v = vec(id, dims)
    vectors.set(id, v)
    db.prepare("INSERT INTO chunks(id, content_id, ord, text, char_start, char_end) VALUES (?, ?, ?, '', 0, 0)").run(id, ((id - 1) % 4) + 1, id)
    db.prepare('INSERT INTO chunk_vectors(space_id, chunk_id, vec) VALUES (1, ?, ?)').run(id, vecToBuffer(v))
  }
  return { db, vectors }
}

describe.each([
  { mode: 'exact float32', quantized: false },
  { mode: 'int8 with float32 rescoring', quantized: true }
])('VectorIndex ($mode)', ({ quantized }) => {
  it('matches brute-force exact search, with exact scores', () => {
    const { db, vectors } = setup(400)
    const index = new VectorIndex(db, { quantized })
    for (const seed of [1000, 1001, 1002]) {
      const q = vec(seed)
      const hits = index.search(q, 10)
      expect(hits.map((h) => h.chunkId)).toEqual(bruteForce(vectors, q, 10))
      const v = vectors.get(hits[0].chunkId)!
      expect(hits[0].score).toBeCloseTo(v.reduce((s, x, i) => s + x * q[i], 0), 5)
    }
  })

  it('removes contents in place, equal to a fresh reload', () => {
    const { db, vectors } = setup()
    const index = new VectorIndex(db, { quantized })
    expect(index.size).toBe(40)
    db.prepare('DELETE FROM contents WHERE id IN (2, 3)').run()
    index.removeContents(new Set([2, 3]))
    for (const id of [...vectors.keys()]) if ([2, 3].includes(((id - 1) % 4) + 1)) vectors.delete(id)
    expect(index.size).toBe(20)
    const q = vec(7)
    const inPlace = index.search(q, 15).map((h) => h.chunkId)
    expect(inPlace).toEqual(bruteForce(vectors, q, 15))
    expect(inPlace).toEqual(new VectorIndex(db, { quantized }).search(q, 15).map((h) => h.chunkId))
  })

  it('handles sizes that are not a multiple of 4', () => {
    const { db, vectors } = setup(30, 386)
    db.prepare('UPDATE embedding_spaces SET dims = 386').run()
    const q = vec(99, 386)
    expect(new VectorIndex(db, { quantized }).search(q, 5).map((h) => h.chunkId)).toEqual(bruteForce(vectors, q, 5))
  })

  it('serves only the active embedding space', () => {
    const { db, vectors } = setup()
    db.prepare("INSERT INTO embedding_spaces(id, model, doc_prefix, query_prefix, status, created_at) VALUES (2, 'other', '', '', 'building', 0)").run()
    db.prepare('INSERT INTO chunk_vectors(space_id, chunk_id, vec) VALUES (2, 1, ?)').run(vecToBuffer(vec(5000)))
    const index = new VectorIndex(db, { quantized })
    expect(index.size).toBe(40)
    index.add(1, 1, vec(5000), 2) // another space's vector is not mixed in
    expect(index.size).toBe(40)
    const q = vec(3)
    expect(index.search(q, 5).map((h) => h.chunkId)).toEqual(bruteForce(vectors, q, 5))
  })
})

describe('int8 quantization (S4-09)', () => {
  it('holds a quarter of the float32 bytes, plus one scale per vector', () => {
    const { db } = setup(100)
    const exact = new VectorIndex(db, { quantized: false })
    const small = new VectorIndex(db, { quantized: true })
    expect(exact.size).toBe(small.size)
    // Capacity grows in the same steps for both, so the ratio is exact.
    expect(small.vectorBytes / exact.vectorBytes).toBeCloseTo((EMBED_DIMS + 4) / (EMBED_DIMS * 4), 5)
  })
})
