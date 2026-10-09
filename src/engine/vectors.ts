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

  /** Forces a full reload from the database on the next search. */
  invalidate(): void {
    this.stale = true
  }

  /** Drops all vectors of the given contents in place (no reload). Call after their chunks are deleted. */
  removeContents(contentIds: Set<number>): void {
    if (this.stale || contentIds.size === 0) return
    const dims = EMBED_DIMS
    let w = 0
    for (let r = 0; r < this.count; r++) {
      if (contentIds.has(this.contentIds[r])) continue
      if (w !== r) {
        this.ids[w] = this.ids[r]
        this.contentIds[w] = this.contentIds[r]
        this.data.copyWithin(w * dims, r * dims, (r + 1) * dims)
      }
      w++
    }
    this.count = w
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
    const data = this.data
    const contentIds = this.contentIds
    const n = this.count
    const dims = EMBED_DIMS
    const heap = new TopK(k)
    // Hot loop: locals only, 4-way unrolled (768 is divisible by 4), min-heap for the top k.
    for (let i = 0, base = 0; i < n; i++, base += dims) {
      if (allow !== undefined && !allow(contentIds[i])) continue
      let s0 = 0
      let s1 = 0
      let s2 = 0
      let s3 = 0
      for (let d = 0; d < dims; d += 4) {
        s0 += data[base + d] * query[d]
        s1 += data[base + d + 1] * query[d + 1]
        s2 += data[base + d + 2] * query[d + 2]
        s3 += data[base + d + 3] * query[d + 3]
      }
      heap.offer(i, s0 + s1 + s2 + s3)
    }
    return heap.sorted().map(({ index, score }) => ({ chunkId: this.ids[index], contentId: contentIds[index], score }))
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

/** Fixed-size min-heap keeping the k highest scores. */
export class TopK {
  private readonly scores: Float64Array
  private readonly items: Int32Array
  private size = 0

  constructor(private readonly k: number) {
    this.scores = new Float64Array(k)
    this.items = new Int32Array(k)
  }

  offer(index: number, score: number): void {
    if (this.k === 0) return
    if (this.size < this.k) {
      let i = this.size++
      while (i > 0) {
        const parent = (i - 1) >> 1
        if (this.scores[parent] <= score) break
        this.scores[i] = this.scores[parent]
        this.items[i] = this.items[parent]
        i = parent
      }
      this.scores[i] = score
      this.items[i] = index
    } else if (score > this.scores[0]) {
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        if (l >= this.size) break
        const r = l + 1
        const c = r < this.size && this.scores[r] < this.scores[l] ? r : l
        if (this.scores[c] >= score) break
        this.scores[i] = this.scores[c]
        this.items[i] = this.items[c]
        i = c
      }
      this.scores[i] = score
      this.items[i] = index
    }
  }

  sorted(): { index: number; score: number }[] {
    const out: { index: number; score: number }[] = []
    for (let i = 0; i < this.size; i++) out.push({ index: this.items[i], score: this.scores[i] })
    return out.sort((a, b) => b.score - a.score)
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
