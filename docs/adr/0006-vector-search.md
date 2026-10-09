# ADR-0006: Exact vector search in memory in the engine

**Status:** Accepted (2026-10-09), with a memory limit. Deviates from the plan; validated by S0-05.

**Context.** The plan proposed storing vectors as BLOBs and searching them with sqlite-vec's scalar distance functions in SQL, with `vec0` as the upgrade path. sqlite-vec is pre-1.0, and packaged apps need extra asar-unpacking for its native library.

**Decision.**
- Vectors are stored as float32 BLOBs in `chunk_vectors`, with foreign-key cascades from chunks.
- They are loaded into one in-memory `Float32Array` in the engine when it starts.
- Search is an exact dot product (vectors are L2-normalised, so this is cosine similarity). The loop is unrolled four ways and a fixed-size min-heap keeps the top k.
- Inserts are appended. Deleted contents are removed in place, so the cache never needs a full reload during indexing.

**Alternatives.** sqlite-vec scalar functions; sqlite-vec `vec0`; LanceDB; HNSW libraries.

**Consequences.**
- No native dependency for vectors.
- Latency grows linearly: about 0.5 ms per 1k chunks.
- Memory costs 3 KB per chunk.
- The `VectorIndex` class is the seam for changing the backend.

**Evidence** ([S0-05](../validation/s0-05-vector-benchmark.md)):
- p95 search latency: 5 ms at 10k chunks, 28 ms at 50k, 53 ms at 100k, 110 ms at 200k.
- Engine memory growth: 340 MB at 50k, 529 MB at 100k, 668 MB at 200k.
- Unit tests show identical results to brute-force search and to a fresh reload after removals.

**Limit and next step.** Memory stays within NFR-09 (≤ 600 MB) up to about 100k chunks. Above that, S4-09 (int8 vectors in memory with exact re-scoring from SQLite) is required.
