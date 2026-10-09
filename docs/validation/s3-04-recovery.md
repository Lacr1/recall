# S3-04: recovery

> Date: 2026-10-09 · Machine: Windows 10 Pro 19045 · Electron 44.7.0 · better-sqlite3 13.0.3

## What was built

| Situation | Before | Now |
|---|---|---|
| **Index damaged** (bad disk sector, file overwritten, not a database) | The engine crashed on every start; after four crashes the window stayed on "Starting Recall…" for good | The engine starts in *problem mode*. A full-screen notice says "Recall's index is damaged. Your files are safe." with **Rebuild index**. The rebuild re-reads the same folders. |
| **Damage found while running** (SQLite reports `SQLITE_CORRUPT`) | Errors were logged and retried forever | The engine records a check for the next start and exits. The supervisor restarts it, the start-up check finds the damage, and the notice above appears. |
| **Index format upgrade fails** | No backup | Before migrating, an existing index is copied with `VACUUM INTO`. After migrating, `quick_check` and `foreign_key_check` must pass. Any failure puts the backup back unchanged; the notice then offers a rebuild. |
| **Index from a newer Recall** | Crash loop | Notice: "This index was made by a newer version of Recall", with **Rebuild index** |
| **Index can't be opened** (disk full, no permission) | Crash loop | Notice with the error, **Try again** and **Rebuild index** |
| **Engine crashes repeatedly** | After four crashes in 5 minutes, nothing; the window was stuck | Banner "Recall's indexer stopped after several problems in a row" with **Restart indexer** (or a full screen if nothing had loaded yet) |

**How a rebuild knows your folders.** The folder list (and the pause setting) is also kept in `folders.json` beside the index, rewritten atomically whenever folders change. A rebuild deletes only the index files, so the new index starts from the same folders, and a banner says so. "Delete all data" still removes everything, folder list included.

## Start-up check: time budget

`npm run bench` (`tests/bench/db-check.test.ts`), OS file cache warm:

| Passages | Index size | `quick_check` | `integrity_check` |
|---|---|---|---|
| 10,000 | 57 MB | 110 ms | 113 ms |
| 50,000 | 286 MB | 565 ms | 576 ms |
| 100,000 | 573 MB | 1,121 ms | 1,156 ms |

Running it on every start would delay large indexes by up to a second. It therefore runs only after an **unclean shutdown** (crash, kill, power loss: no `clean-shutdown` marker) or when SQLite reported damage while running. After a clean quit, start-up skips it. SQLite still detects damaged pages whenever it reads them, which triggers the check on the next start.

## Evidence

| Test | Where | Result |
|---|---|---|
| Unclean shutdown triggers the check, clean shutdown skips it | `tests/integration/recovery.test.ts` | pass |
| Non-database file → `damaged` | same | pass |
| Garbage written over 4 pages mid-file → `damaged` | same | pass |
| `user_version` above the app's → `newer_version` | same | pass |
| Failed upgrade (single and multi-step) → `migration_failed`, data and version unchanged, no backup left behind | same | pass |
| Successful upgrade → new version, data kept, backup removed | same | pass |
| Rebuild removes only index files and keeps the folder list | same | pass |
| Engine killed 3 times while indexing → "restarted" banner each time, indexing completes, search works, index consistent afterwards | `tests/e2e/recovery.spec.ts` | pass (built app **and packaged `Recall.exe`**) |
| 4th kill → supervisor stops; **Restart indexer** brings it back | same | pass (both) |
| Damaged index on next launch → notice (accessibility scan clean) → **Rebuild index** → same folder restored, re-indexed, search works | same | pass (both) |

The whole E2E suite (14 tests) now also runs against the packaged app (`RECALL_E2E_EXE=dist/win-unpacked/Recall.exe npx playwright test`), and passed. The network audit on the new package still shows nothing leaving the machine.

## Limits

- **Damage during a session:** recovery from damage that SQLite reports mid-session is wired up (engine exits, check on restart) but not exercised end to end. Faking `SQLITE_CORRUPT` in a running engine needs fault injection that does not exist yet.
- **No salvage from a damaged index:** nothing is read out of it; the folder list comes from `folders.json`. An index from before this change has no `folders.json` until its first start with this version.
- **Rebuild cost:** a rebuild re-reads and re-embeds everything. For large folders that takes as long as the first index (about 7 passages per second on this machine's CPU).
- **No diagnostics export** on the "indexer stopped" banner yet (plan doc 02 §5.13 lists one).
