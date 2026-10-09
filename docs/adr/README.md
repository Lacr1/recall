# Architecture Decision Records

One file per decision, using the template **Status · Context · Decision · Alternatives · Consequences · Evidence**. A changed decision gets a new ADR that supersedes the old one; the old file is kept and marked *Superseded*.

Statuses:
- *Proposed*: not yet validated.
- *Accepted*: validated by the evidence listed in the file.
- *Amended*: accepted, with a recorded deviation from the plan.
- *Superseded*: replaced by a later ADR.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-electron-runtime.md) | Electron desktop runtime | Accepted |
| [0002](0002-react-vite-renderer.md) | React + Vite via electron-vite, no Next.js | Accepted |
| [0003](0003-engine-utility-process.md) | Engine in a `utilityProcess`; main process only brokers calls | Accepted |
| [0004](0004-sqlite-better-sqlite3.md) | SQLite via better-sqlite3 13 as the single source of truth | Accepted |
| [0005](0005-content-addressed-storage.md) | Content-addressed storage: files → contents → chunks | Accepted |
| [0006](0006-vector-search.md) | Exact vector search in memory in the engine | Accepted (limit: ~100k chunks before int8) |
| [0007](0007-fts5-keyword-search.md) | FTS5 BM25 (porter) for chunks and file names | Accepted |
| [0008](0008-rrf-hybrid-ranking.md) | Reciprocal Rank Fusion plus an all-terms list and a meaning margin | Amended |
| [0009](0009-ollama-thin-client.md) | Ollama through a thin loopback-only HTTP client | Accepted |
| [0010](0010-db-state-as-queue.md) | Database status columns are the work queue | Accepted |
| [0011](0011-extraction-isolation.md) | Extraction isolated in worker threads | Proposed (not built) |
| [0012](0012-electron-builder-nsis.md) | electron-builder NSIS per-user installer | Accepted |
| [0013](0013-loopback-network-policy.md) | Loopback-only network policy | Accepted (manual offline check pending) |
| [0014](0014-index-recovery.md) | Recover by rebuilding the index from a saved folder list | Accepted |
