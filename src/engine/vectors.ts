import type { DB } from './db'
import { EMBED_DIMS } from '../shared/constants'

/**
 * Exact cosine search over all chunk vectors, held in memory as one Float32Array.
 * Vectors are L2-normalised, so cosine similarity is a dot product. Fine at demo scale
 * (~30 MB per 10k chunks); plan ADR-006 covers moving to sqlite-vec when needed.
 */
export class VectorIndex {
  private ids = new Int32Array(0)
  private contentIds = new Int32Array(0)
  private data = new Float32Array(0)
  private count = 0
  private stale = true

  constructor(private readonly db: DB) {}

  /** Call after deletions; the index reloads lazily on the next search. */
  invalidate(): void {
    this.stale = true
  }

  add(chunkId: number, contentId: number, vec: Float32Array): void {
    if (this.stale) return // will be loaded from the DB anyway
    this.ensureCapacity(this.count + 1)
    this.ids[this.count] = chunkId
    this.contentIds[this.count] = contentId
    this.data.set(vec, this.count * EMBED_DIMS)
    this.count++
  }

  get size(): number {
    if (this.stale) this.load()
    return this.count
  }

  search(query: Float32Array, k: number, allow?: (contentId: number) => boolean): { chunkId: number; contentId: number; score: number }[] {
    if (this.stale) this.load()
    const top: { chunkId: number; contentId: number; score: number }[] = []
    let floor = -Infinity
    for (let i = 0; i < this.count; i++) {
      const cid = this.contentIds[i]
      if (allow && !allow(cid)) continue
      const base = i * EMBED_DIMS
      let dot = 0
      for (let d = 0; d < EMBED_DIMS; d++) dot += this.data[base + d] * query[d]
      if (top.length < k || dot > floor) {
        top.push({ chunkId: this.ids[i], contentId: cid, score: dot })
        if (top.length > k) {
          top.sort((a, b) => b.score - a.score)
          top.length = k
        }
        floor = top.length === k ? Math.min(...top.map((t) => t.score)) : -Infinity
      }
    }
    return top.sort((a, b) => b.score - a.score)
  }

  private load(): void {
    const rows = this.db
      .prepare('SELECT v.chunk_id, c.content_id, v.vec FROM chunk_vectors v JOIN chunks c ON c.id = v.chunk_id')
      .all() as { chunk_id: number; content_id: number; vec: Buffer }[]
    this.count = 0
    this.ensureCapacity(rows.length)
    for (const r of rows) {
      this.ids[this.count] = r.chunk_id
      this.contentIds[this.count] = r.content_id
      this.data.set(bufferToVec(r.vec), this.count * EMBED_DIMS)
      this.count++
    }
    this.stale = false
  }

  private ensureCapacity(n: number): void {
    if (this.ids.length >= n) return
    const cap = Math.max(n, this.ids.length * 2, 1024)
    const ids = new Int32Array(cap)
    ids.set(this.ids.subarray(0, this.count))
    const cids = new Int32Array(cap)
    cids.set(this.contentIds.subarray(0, this.count))
    const data = new Float32Array(cap * EMBED_DIMS)
    data.set(this.data.subarray(0, this.count * EMBED_DIMS))
    this.ids = ids
    this.contentIds = cids
    this.data = data
  }
}

export function toUnitVec(v: number[]): Float32Array {
  const out = new Float32Array(v)
  let norm = 0
  for (const x of out) norm += x * x
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < out.length; i++) out[i] /= norm
  return out
}

export function vecToBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
}

export function bufferToVec(b: Buffer): Float32Array {
  const copy = new Uint8Array(b) // aligned copy
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4)
}
