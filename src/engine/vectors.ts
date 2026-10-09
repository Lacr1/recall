import type { DB } from './db'

export interface VectorIndexOptions {
  /**
   * Plan doc 04 §5.4 (S4-09): keep int8 vectors in memory (4× smaller than float32) and re-score the best
   * candidates with the exact float32 vectors from the database. Default on; off gives exact float32 search.
   */
  quantized?: boolean
  /** Candidates re-scored per result asked for (quantized mode). */
  rescoreFactor?: number
}

/**
 * Exact-or-near-exact cosine search over the active embedding space's chunk vectors, held in memory.
 * Vectors are L2-normalised, so cosine similarity is a dot product. Plan ADR-006 covers moving to
 * sqlite-vec when needed.
 */
export class VectorIndex {
  readonly quantized: boolean
  private readonly rescoreFactor: number
  private spaceId = 0
  private dims = 0
  private ids = new Int32Array(0)
  private contentIds = new Int32Array(0)
  /** float32 rows (exact mode) */
  private f32 = new Float32Array(0)
  /** int8 rows and their per-row scale (quantized mode): value ≈ q8 * scale */
  private q8 = new Int8Array(0)
  private scales = new Float32Array(0)
  private count = 0
  private stale = true
  private vecStmt?: { get(spaceId: number, chunkId: number): unknown }

  constructor(
    private readonly db: DB,
    opts: VectorIndexOptions = {}
  ) {
    this.quantized = opts.quantized ?? true
    this.rescoreFactor = opts.rescoreFactor ?? 2
  }

  /** Forces a full reload from the database on the next search, e.g. after the active space changed. */
  invalidate(): void {
    this.stale = true
  }

  /** The embedding space whose vectors are loaded (after the next search or `size`). */
  get activeSpaceId(): number {
    if (this.stale) this.load()
    return this.spaceId
  }

  /** Drops all vectors of the given contents in place (no reload). Call after their chunks are deleted. */
  removeContents(contentIds: Set<number>): void {
    if (this.stale || contentIds.size === 0) return
    const dims = this.dims
    let w = 0
    for (let r = 0; r < this.count; r++) {
      if (contentIds.has(this.contentIds[r])) continue
      if (w !== r) {
        this.ids[w] = this.ids[r]
        this.contentIds[w] = this.contentIds[r]
        if (this.quantized) {
          this.q8.copyWithin(w * dims, r * dims, (r + 1) * dims)
          this.scales[w] = this.scales[r]
        } else this.f32.copyWithin(w * dims, r * dims, (r + 1) * dims)
      }
      w++
    }
    this.count = w
  }

  /** Adds a vector of `spaceId`; ignored unless that is the loaded (active) space. */
  add(chunkId: number, contentId: number, vec: Float32Array, spaceId: number): void {
    if (this.stale || spaceId !== this.spaceId) return // a reload picks it up
    if (!this.dims) {
      // First vector of an empty space: size the arrays for its dimensions.
      this.dims = vec.length
      this.ids = new Int32Array(0)
    }
    if (vec.length !== this.dims) return
    this.ensureCapacity(this.count + 1)
    this.put(this.count, chunkId, contentId, vec)
    this.count++
  }

  get size(): number {
    if (this.stale) this.load()
    return this.count
  }

  /** Bytes held for vector data, for benchmarks. */
  get vectorBytes(): number {
    return this.quantized ? this.q8.byteLength + this.scales.byteLength : this.f32.byteLength
  }

  search(query: Float32Array, k: number, allow?: (contentId: number) => boolean): { chunkId: number; contentId: number; score: number }[] {
    if (this.stale) this.load()
    if (!this.count || query.length !== this.dims) return []
    if (!this.quantized) return this.scan(query, k, allow).map(({ index, score }) => this.hit(index, score))
    const pool = this.scan(query, k * this.rescoreFactor, allow)
    return this.rescore(query, pool.map((p) => p.index)).slice(0, k)
  }

  /** Top `k` rows by dot product with the query (approximate in quantized mode). */
  private scan(query: Float32Array, k: number, allow?: (contentId: number) => boolean): { index: number; score: number }[] {
    const contentIds = this.contentIds
    const n = this.count
    const dims = this.dims
    const dims4 = dims & ~3
    const heap = new TopK(k)
    // Hot loops: locals only, 4-way unrolled with a tail for sizes not divisible by 4, min-heap for the top k.
    // One loop per array type, so each stays monomorphic for the JIT.
    if (this.quantized) {
      const data = this.q8
      const scales = this.scales
      for (let i = 0, base = 0; i < n; i++, base += dims) {
        if (allow !== undefined && !allow(contentIds[i])) continue
        let s0 = 0
        let s1 = 0
        let s2 = 0
        let s3 = 0
        let d = 0
        for (; d < dims4; d += 4) {
          s0 += data[base + d] * query[d]
          s1 += data[base + d + 1] * query[d + 1]
          s2 += data[base + d + 2] * query[d + 2]
          s3 += data[base + d + 3] * query[d + 3]
        }
        for (; d < dims; d++) s0 += data[base + d] * query[d]
        heap.offer(i, (s0 + s1 + s2 + s3) * scales[i])
      }
    } else {
      const data = this.f32
      for (let i = 0, base = 0; i < n; i++, base += dims) {
        if (allow !== undefined && !allow(contentIds[i])) continue
        let s0 = 0
        let s1 = 0
        let s2 = 0
        let s3 = 0
        let d = 0
        for (; d < dims4; d += 4) {
          s0 += data[base + d] * query[d]
          s1 += data[base + d + 1] * query[d + 1]
          s2 += data[base + d + 2] * query[d + 2]
          s3 += data[base + d + 3] * query[d + 3]
        }
        for (; d < dims; d++) s0 += data[base + d] * query[d]
        heap.offer(i, s0 + s1 + s2 + s3)
      }
    }
    return heap.sorted()
  }

  /** Exact scores for the given rows, from the float32 vectors in the database, best first. */
  private rescore(query: Float32Array, rows: number[]): { chunkId: number; contentId: number; score: number }[] {
    if (!rows.length) return []
    // Primary-key lookups, one per candidate: cheaper than an IN list the planner may not index.
    this.vecStmt ??= this.db.prepare('SELECT vec FROM chunk_vectors WHERE space_id = ? AND chunk_id = ?').pluck()
    const out: { chunkId: number; contentId: number; score: number }[] = []
    for (const i of rows) {
      const blob = this.vecStmt.get(this.spaceId, this.ids[i]) as Buffer | undefined
      if (!blob) continue
      const v = blob.byteOffset % 4 === 0 ? new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4) : bufferToVec(blob)
      let s = 0
      for (let d = 0; d < v.length; d++) s += v[d] * query[d]
      out.push(this.hit(i, s))
    }
    return out.sort((a, b) => b.score - a.score)
  }

  private hit(index: number, score: number) {
    return { chunkId: this.ids[index], contentId: this.contentIds[index], score }
  }

  private put(row: number, chunkId: number, contentId: number, vec: Float32Array): void {
    this.ids[row] = chunkId
    this.contentIds[row] = contentId
    const base = row * this.dims
    if (!this.quantized) {
      this.f32.set(vec, base)
      return
    }
    let max = 0
    for (let d = 0; d < vec.length; d++) max = Math.max(max, Math.abs(vec[d]))
    const scale = max / 127 || 1
    for (let d = 0; d < vec.length; d++) this.q8[base + d] = Math.round(vec[d] / scale)
    this.scales[row] = scale
  }

  private load(): void {
    const space = this.db.prepare("SELECT id, dims FROM embedding_spaces WHERE status = 'active'").get() as { id: number; dims: number | null }
    const rows = this.db
      .prepare('SELECT v.chunk_id, c.content_id, v.vec FROM chunk_vectors v JOIN chunks c ON c.id = v.chunk_id WHERE v.space_id = ?')
      .all(space.id) as { chunk_id: number; content_id: number; vec: Buffer }[]
    this.spaceId = space.id
    this.dims = space.dims ?? (rows[0] ? rows[0].vec.byteLength / 4 : 0)
    this.count = 0
    this.ids = new Int32Array(0)
    this.ensureCapacity(rows.length)
    for (const r of rows) {
      const v = bufferToVec(r.vec)
      if (v.length !== this.dims) continue
      this.put(this.count, r.chunk_id, r.content_id, v)
      this.count++
    }
    this.stale = false
  }

  private ensureCapacity(n: number): void {
    if (this.ids.length >= n) return
    const cap = Math.max(n, this.ids.length * 2, 1024)
    const dims = Math.max(this.dims, 1)
    const grow = <T extends Int32Array | Float32Array | Int8Array>(old: T, make: (len: number) => T, len: number, used: number): T => {
      const next = make(len)
      next.set(old.subarray(0, used) as never)
      return next
    }
    this.ids = grow(this.ids, (l) => new Int32Array(l), cap, this.count)
    this.contentIds = grow(this.contentIds, (l) => new Int32Array(l), cap, this.count)
    if (this.quantized) {
      this.q8 = grow(this.q8, (l) => new Int8Array(l), cap * dims, this.count * dims)
      this.scales = grow(this.scales, (l) => new Float32Array(l), cap, this.count)
    } else {
      this.f32 = grow(this.f32, (l) => new Float32Array(l), cap * dims, this.count * dims)
    }
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
