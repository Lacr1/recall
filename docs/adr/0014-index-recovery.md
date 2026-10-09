# ADR-0014: Recover by rebuilding the index from a saved folder list

**Status:** Accepted (2026-10-09)

**Context.** The index is derived from the user's files, so it can always be recreated. The only user decisions stored in it are which folders to index and whether indexing is paused. Before this change, a damaged or unreadable index crashed the engine at every start, and the window waited forever.

**Decision.**
- **Saved folder list.** The folder list and pause setting are also written to `folders.json` in the data folder, atomically, whenever they change.
- **Problem mode.** If the index can't be used (damaged, newer version, failed upgrade, can't open), the engine starts in problem mode. It answers status with the problem and refuses everything else. The window shows a full-screen notice with **Rebuild index**.
- **Rebuild.** Main stops the engine, deletes only the index files, and starts it again. A new empty index next to a saved folder list re-adds those folders and shows a "rebuilt" banner.
- **When to check integrity.** `quick_check` runs on start only after an unclean shutdown, or when SQLite reported damage while running. That keeps normal starts fast; the check takes about 11 ms per 1,000 passages.
- **Upgrade backup.** Upgrades of an existing index use a `VACUUM INTO` backup, a check after migrating, and an automatic restore on failure.
- **Supervisor.** After 4 crashes in 5 minutes, the supervisor stops and tells the window, which offers **Restart indexer**.

**Alternatives.**
- Rebuild automatically without asking. Rejected: re-embedding can take hours, so the user should choose when.
- Salvage rows from the damaged file. Rejected: complex, and still untrustworthy.
- Always run `quick_check`. Rejected: about 1 s per 100k passages on every start.
- Keep the folder list only in SQLite. Rejected: it would be lost with the index.

**Consequences.**
- A damaged index costs a full re-index but never the user's folder choices.
- `folders.json` is a second place that must stay in sync. The engine writes it after every folder change and on every start.

**Evidence.** [s3-04-recovery.md](../validation/s3-04-recovery.md): unit and integration tests for each case; E2E tests for crash restarts, giving up, and damaged index then rebuild, run on both the built and the packaged app.
