# S0-05: Vector search benchmark

> Date: 2026-10-09 · Machine: AMD Ryzen 7 5700G, 15.4 GB RAM, Windows 10 19045, Node 24.21.0 · Command: `npm run bench` (writes `eval-results/bench-vectors.md`)
>
> Method: synthetic 768-dimension float32 unit vectors stored in `chunk_vectors` (about 8 chunks per content), loaded into `VectorIndex`, exact top-100 search, 30 queries per size after a warm-up query. Vectors are random, so latency matches real embeddings but ranking quality is not measured here (that is the job of `npm run test:live`).

## Results

The first run used the original plain loop. The rewrite keeps local references, unrolls the dot product four ways and uses a fixed-size min-heap for top-k.

| Chunks | p50, original loop | p50 / p95, rewritten loop | p95 with the app's live-content filter | Load from DB | Memory added (RSS) | DB size (vectors only) | Inserts/s |
|---|---|---|---|---|---|---|---|
| 10,000 | 77.6 ms | 5.1 / 5.3 ms | 8.8 ms | 85 ms | 88 MB | 40 MB | ~14k |
| 50,000 | 378.8 ms | 26.1 / 27.9 ms | 32.3 ms | 424 ms | 340 MB | 199 MB | ~16k |
| 100,000 | 759.8 ms | 51.6 / 52.6 ms | 54.0 ms | 923 ms | 529 MB | 397 MB | ~15k |
| 200,000 | 1,522.7 ms | 104.7 / 109.7 ms | 111.6 ms | 1,807 ms | 668 MB | 794 MB | ~16k |

Memory figures are the engine's RSS growth while loading, which includes temporary buffers. The steady-state array is 3 KB per chunk (614 MB at 200k).

## Decision (ADR-0006 → Accepted, with a limit)

- **Latency:** in-memory exact search in JavaScript is fast enough across the planned range of up to 200k chunks (assumption A-02). Vector search p95 is 110 ms at 200k, so it isn't the bottleneck for the plan's hybrid-search target (NFR-04: p95 ≤ 1.5 s). Warm query embedding adds about 36 ms.
- **Memory:** the engine budget (NFR-09, ≤ 600 MB) holds up to about **100k chunks**. Above that, plan **S4-09 (int8 compression with exact re-scoring)** is required. Expected cost is about 1 byte per dimension (154 MB at 200k). Until then the limit is recorded in [10 §4](../app-plan/10-risks-and-open-decisions.md) (TA-03).
- **Database size:** vectors take about 4 KB per chunk on disk, before chunk text and the FTS index. That matches the estimate in plan [05 §8.1](../app-plan/05-data-model-and-indexing.md).
- sqlite-vec isn't needed for the MVP.

## Fixes made because of this benchmark

- **Hot loop rewritten:** about 14× faster at every size.
- **No more full cache reload after each file:** previously every extraction and every cleanup pass invalidated the whole vector cache, so at 200k chunks each one cost a 1.8 s reload before the next search. Now only contents whose chunks were actually replaced or deleted are removed, in place. New tests check that this gives the same results as a fresh reload and as brute-force search.
- **Cache warmed at start-up:** the engine loads the vector cache when it starts, so the first search after launch isn't the one that pays for it.
- **Smoke test isolated:** the smoke test now uses its own Electron profile, so it runs even while a normal Recall window is open.

## Not covered

Real embeddings at scale (quality versus scale), int8 compression, and searching while heavy indexing writes are happening (the plan's reader-thread option in [03 §6](../app-plan/03-system-architecture.md)).
