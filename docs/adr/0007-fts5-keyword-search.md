# ADR-0007: FTS5 BM25 for chunks and file names

**Status:** Accepted (2026-10-09)

**Decision.**
- `chunks_fts` and `files_fts` are external-content FTS5 tables. They use the `porter unicode61 remove_diacritics 2` tokenizer and are kept in sync by triggers.
- User text never reaches `MATCH` directly. Query terms are extracted, quoted, and combined with OR (any-term list) or AND (all-terms list).
- File names and paths are pre-split on `_`, `-`, `.`, camelCase and letter–digit boundaries.

**Evidence.**
- A unit test shows that FTS syntax in a query (`NEAR`, `*`, quotes, parentheses) can't change its meaning.
- The consistency check runs FTS5's `integrity-check`.
