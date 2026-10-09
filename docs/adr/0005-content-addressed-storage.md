# ADR-0005: Content-addressed storage (files → contents → chunks)

**Status:** Accepted (2026-10-09)

**Context.** Renames, moves and duplicate copies are common in personal folders. Re-embedding them every time would waste CPU-bound indexing time.

**Decision.**
- A `files` row is a path. A `contents` row is a unique SHA-256 hash plus the extractor kind.
- Chunks and vectors belong to contents, not files.
- Orphaned contents are garbage-collected after 10 minutes, or immediately when their folder is removed.

**Consequences.** A move or rename costs one hash and no model calls. Identical copies collapse into a single search result.

**Evidence.** Integration tests show:
- renaming a file makes zero embedding calls;
- a duplicate in Downloads shows up as "2 copies";
- removing a folder leaves no orphaned rows.
