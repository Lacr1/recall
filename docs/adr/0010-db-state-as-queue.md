# ADR-0010: Database status columns are the work queue

**Status:** Accepted (2026-10-09)

**Decision.**
- There is no separate job table. The scan, hash, extract, embed and garbage-collection lanes pick their next work from `files.status`, `contents.extract_status` and `contents.embed_status`.
- Each content's chunks are written in one transaction, and each batch of vectors in another.
- Only a completed scan marks unseen files as deleted, using scan generations. A missing folder root never deletes anything.

- A lane that did work wakes the other lanes, so work flows to the next stage at once instead of after a 10-second idle wait.

**Consequences.** A crash loses only work held in memory; rows still pending resume on restart.

**Evidence** ([S1-08](../validation/s1-08-crash-loop.md)):
- The indexer, run as a separate process, was killed 20 times mid-work per run, for 8 seeds (160 kills), with file edits, renames, deletes, copies and new files between kills.
- Every kill left a consistent index.
- Each final index matched a clean index of the same files exactly: passages, vectors and keyword matches.
- A planted non-atomic write was caught on the second run.

**Open.** The same loop against the packaged app (S3-04).
