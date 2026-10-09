# S1-08: crash-loop test

> Date: 2026-10-09 · Machine: Windows 10 Pro 19045 · Node 24.21.0 · better-sqlite3 13.0.3

## Question

Recall promises that it is safe to quit, or to crash, at any moment. Does the index stay correct when the indexer dies mid-work, and does it end up the same as if nothing had happened?

## Method

`tests/integration/crash-loop.test.ts`, part of `npm test`:

1. **Separate process.** The real indexer (`Indexer`, `VectorIndex`, SQLite) runs in a child Node process (`tests/support/crash-harness.ts`, bundled with esbuild). Embeddings come from the fake Ollama server over loopback HTTP, so no code is mocked.
2. **Kills mid-work.** The harness prints a line after every indexing step (a scan, a batch of hashes, one extraction, one embedding batch). For each run the test picks a seeded random step and a 0–30 ms delay after it, then kills the process. On Windows that terminates it at once, with no cleanup code, like a crash.
3. **Check after every kill.** The test opens the database, which recovers SQLite's write-ahead log as the app would, and runs `assertIndexConsistent`.
4. **Changes between kills.** Each run adds a new note, and most also edit, rename, delete, copy or re-date a file. Restarts therefore exercise re-reading, rename handling, duplicates and cleanup, not just resumption.
5. **Twenty kills** per run (at most 60 attempts; a run that finishes before its kill point doesn't count).
6. **Final comparison.** The indexer then runs to completion. Old versions of changed files are aged past their 10-minute cleanup delay, and one more run cleans them up. Finally, the same files are indexed from scratch in a fresh database and both are compared.

`assertIndexConsistent` was strengthened for this. It now checks:
- no vector without its passage, and no passage without its content;
- keyword index row counts and FTS5 integrity for passages and file names;
- no linked file without content;
- passage counts match what each content records;
- content marked "embedded" has a vector for every passage;
- SQLite `quick_check` and foreign keys.

The final comparison covers, for every file:
- its status;
- a fingerprint of its content's passages (text, offsets, pages, sections) and their exact vector bytes;
- the full list of files matching several keywords and file-name words.

It also checks that the in-memory vector cache, kept up to date through additions and removals during indexing, holds exactly as many vectors as the database.

## Results

| Seed | Kills | Consistent after every kill | Final index identical to clean index |
|---|---|---|---|
| 20261009 (default) | 20 | yes | yes |
| 7, 99, 1234, 42, 5, 777, 31337 | 20 each | yes | yes |

160 kills in total, all consistent. One run takes about 12 s.

**The test catches real bugs.** A planted bug wrote the passages and the "read" status in separate transactions with a short pause between them. It was caught on the second run: `Index inconsistent: chunk count differs from chunks`.

## Bugs found on the way (fixed)

| Bug | Effect | Fix |
|---|---|---|
| Lanes didn't wake each other | After one stage finished work, the next stage slept up to 10 s before noticing. A fresh 18-file index took about 22 s instead of about 3 s. In the app, keyword search and the "Understanding" phase started late. | A lane that did work wakes the others. `npm test` went from 27 s to 13 s, and the E2E suite from 29 s to 13 s. |
| Identical copies with the same modified time | Which copy was shown as the main result depended on internal row order | Ties are broken by path |

## Limits

- **Kill points:** kills land between or just after indexing steps (step count plus 0–30 ms). The test does not inject failures inside a single SQLite write; SQLite's own atomicity covers that.
- **What a kill simulates:** a process kill, not a power cut. With `synchronous=NORMAL`, a power cut can lose the last committed transactions but not corrupt the database. Not tested.
- **Process type:** the harness is a Node child process, not Electron's `utilityProcess`, and not the packaged app (S3-04).
- **Ranked search not compared:** files that share an identical passage tie exactly, and ties follow internal row order, which differs between two databases. The comparison therefore uses full keyword match lists and exact data instead of ranked results.
