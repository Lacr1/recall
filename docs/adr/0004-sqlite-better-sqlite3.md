# ADR-0004: SQLite via better-sqlite3 13 as the single source of truth

**Status:** Accepted (2026-10-09)

**Context.** Recall needs one local, transactional store for folders, files, contents, chunks, vectors and settings, with full-text search.

**Decision.**
- better-sqlite3 13.0.3. Its Node-API prebuilds mean one binary works under both Node (Vitest) and Electron, with no rebuild.
- WAL mode, `synchronous=NORMAL`, foreign keys on.
- Only the engine opens the database.
- The package's install script (a `node-gyp` source build) is denied in `allowScripts`; the bundled prebuild is used instead.

**Alternatives.**
- `node:sqlite` (still a release candidate in Node 24).
- LanceDB.

**Consequences.** The index can always be rebuilt from the user's files, so corruption recovery can fall back to a full rebuild (S3-04).

**Evidence.** better-sqlite3 loads with FTS5 (SQLite 3.53.4) in Node, in the Electron utilityProcess and in the packaged app. All 25 tests run against real SQLite.
