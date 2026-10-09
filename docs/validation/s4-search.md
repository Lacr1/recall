# Stage 4: search improvements (S4-01 … S4-09)

> Date: 2026-10-10 · Machine: Windows 10 Pro 19045, AMD Ryzen 7 5700G, 15.4 GB RAM · Ollama 0.40.2, `nomic-embed-text`
> Scope: all of Stage 4 from the [backlog](../app-plan/11-implementation-backlog.md) except S4-08 (global shortcut, search history, throttle modes), which was left out on purpose.

## What was built

| Item | What it does | Where |
|---|---|---|
| S4-01 Filters | Type (PDF, Word, notes and text, code, images), folder and modified-date filters, applied as SQL inside the keyword, meaning and file-name candidate lists, so filtering happens before ranking. Dropdowns under the search box; each active filter is a removable chip; "Clear filters". | `search.ts` `filePredicate`, `FilterBar.tsx` |
| S4-02 Time words | A rule-based parser takes time words out of the query. Ordering words ("latest", "newest", "most recent", "current version", "updated") add a fourth RRF list of the top 50 candidates by modified date. Ranges ("today", "last week", "past 30 days", "last month", "March 2026", "in May", "2025") become a date filter shown as a chip. Removing a chip searches the words as typed. A query of only time words or filters lists matching files newest first. Voice search uses the same rules. | `temporal.ts`, `search.ts` `addNewestList` |
| S4-03 Eval set and calibration | 238-file synthetic corpus (10 version families, 4 duplicate sets, 10 template look-alike pairs, 8 OCR images and scans) and 168 labelled queries with a 25% holdout. Harness reports the 07 §5.4 gates, modes, experiments, per-type and per-split tables, low-confidence calibration and version-grouping quality. | `scripts/make-eval-corpus.mjs`, `tests/fixtures/eval-corpus/`, `tests/eval/queries-s4.jsonl`, `tests/live/eval-s4.test.ts` → `eval-results/s4-eval.md` |
| S4-04 Versions | MinHash signatures (128 hashes, word 5-grams) with LSH bands; candidates also come from the file-name index, since heavily edited versions share too little text for LSH. One result per family with "N versions"; the evidence pane lists versions newest first. The best match leads; "latest" queries lead with the newest; typing a version's file name leads with that version. | `versions.ts`, index format v3 |
| S4-05 Evidence | Up to 3 passages per result with page or section labels (existing). New: "Show in document" opens the detail view at that passage; passages and matched words can be stepped through (F3 / Shift+F3). Works for matches found by meaning only. | `DocumentPanel.tsx`, `documents.ts` |
| S4-06 OCR | Off by default (Settings → Text in images). On: PNG, JPEG, BMP, TIFF and WebP images and PDFs without a text layer (rendered at 200 dpi, up to 30 pages) are read with tesseract.js and English data bundled with the app. Off: images are not indexed at all and no OCR worker runs. Decision D-06 = option (a). | `ocr.ts`, `extract.ts` |
| S4-07 Model change | Vectors belong to an embedding space (index format v2). Settings → Search model → Change model… builds a new space in the background while search keeps using the active one, then swaps in one transaction and deletes the old vectors. A model updated in Ollama under the same name (new digest) triggers the same rebuild. A model with no calibrated threshold gets no low-confidence flag. | `spaces.ts`, `indexer.ts` `buildLoop`, `AiPanel.tsx` |
| S4-09 Storage | The in-memory vector index holds int8 vectors (4× smaller) and re-scores the best 200 candidates from the float32 vectors in the database. The trigger in plan 04 §5.4 was met: the S0-05 benchmark showed 529 MB of RSS for 100k chunks, near NFR-09's 600 MB. | `vectors.ts` |

## Evaluation results

Full report: [eval-results/s4-eval.md](../../eval-results/s4-eval.md). 168 queries (148 answerable, 20 negative; 39 holdout), 237 files indexed in 55 s.

| Gate | Target | Measured | Met |
|---|---|---|---|
| Hybrid Recall@10 (holdout) | ≥ 0.85 | 0.94 | yes |
| Hybrid MRR@10 (holdout) | ≥ 0.60 | 0.87 | yes |
| Hybrid − best single mode, Recall@10 (holdout) | ≥ +0.03 | +0.02 | **no** (+0.03 over all 148 queries) |
| Negative queries flagged low-confidence (holdout) | ≥ 0.70 | 0.60 | **no** |
| Answerable queries wrongly flagged (holdout) | ≤ 0.10 | 0.09 | yes |
| S4-02: intended version in top 5 on temporal queries | ≥ 0.80 | 1.00 | yes |
| S4-02: non-temporal Recall@10 change | ±0.01 | 0.00 | yes |
| S4-04: false merges on template look-alikes | < 0.05 | 0.00 (0/10) | yes; 27/27 version pairs grouped |
| S4-09: int8 Recall@10 loss vs float32 | ≤ 0.01 | 0.00 | yes |

| Mode, all answerable queries | Recall@10 | MRR@10 | nDCG@10 |
|---|---|---|---|
| keyword | 0.88 | 0.81 | 0.75 |
| semantic | 0.80 | 0.78 | 0.72 |
| **hybrid (shipped)** | **0.91** | **0.86** | **0.78** |
| hybrid, time words ignored | 0.91 | 0.85 | 0.76 |
| hybrid, no version grouping | 0.90 | 0.85 | 0.82 |

nDCG is lower with grouping because older versions (grade 1) move into the result's versions list, which the metric doesn't credit. Recall@10 counts them, since they are on the first screen.

Vector benchmark ([bench-vectors.md](../../eval-results/bench-vectors.md)): at 200k chunks the in-memory vector arrays take 147 MB instead of 586 MB (74 vs 293 MB at 100k). Search is slower because of re-scoring: p50 148 ms vs 119 ms at 200k chunks. The machine was busy during the run, so the 100k numbers are noisy. Warm hybrid search on the eval corpus is p50 22 ms (int8) vs 18 ms (float32). The benchmark's RSS column needs `--expose-gc` to mean anything (without it the int8 rows read negative), so it isn't quoted here.

## Verification

| Check | Result |
|---|---|
| Typecheck | pass |
| Unit + integration (`npm test`) | 293 / 293 in 20 files. New: `temporal`, `versions`, `migration`, vector modes, `search-filters` (filters, time words, versions, passages), `model-change`, `ocr` (real tesseract, image and scanned PDF, under the network guard) |
| End-to-end + axe (`npm run test:e2e`) | 39 / 39 on the built app **and** on the packaged `Recall.exe`. New flows: filters and chips, versions list, passage stepping, model switch, OCR on and off. New axe screens: "search: versions", "search: filtered", "details: passages", "settings: switching search model", "settings: OCR on" |
| Network audit (`npm run audit:network`) | pass: 8 connection attempts, all loopback, none blocked |
| Live Ask (`tests/live/ask.test.ts`) | 2 / 2 |
| Stage 4 eval (`tests/live/eval-s4.test.ts`) | see above |
| Original 18-file eval (`tests/live/eval.test.ts`) | hybrid Hit@5 0.95, Recall@5 0.95, MRR@10 0.93 (was 1.00, 1.00, 0.95). The drop is one query, q02 ("the proposal where half the fee was paid up front"): its target, Acme v2, is now listed under the v1 result as a version, and this older harness only scores result files. The Stage 4 eval measures the same trade-off (target shown in top 5: 0.93 grouped vs 0.95 ungrouped). Kept, per the 07 §5.4 regression rule. |
| Installer | 291.7 MB (was 281 MB): OCR adds about 11 MB |

**Packaging finding:** tesseract.js 7.0.0's worker passes a boolean where `getCore` expects an OEM number, so it always loads the non-LSTM wasm builds. The first packaged build left those out and OCR failed only in the installed app. Now every build's `.js` and `.wasm` are packaged, and only the browser-only `.wasm.js` copies are dropped.

Ask keeps the plan's first low-confidence rule as its "is there evidence to answer from" gate (`lowConfidenceRule: 'ask'`). It was validated with that rule, and the stricter search rule would refuse most full questions.

## Decisions and changes from the plan

- **D-06 decided: (a).** OCR uses tesseract.js 7.0.0 with `@tesseract.js-data/eng` 1.0.0 (the 2.9 MB `4.0.0_best_int` model). Only the `*-lstm` wasm builds and that model are packaged.
- **Low-confidence rule revised (plan 04 §6.5).** The plan's first rule ("under half the words, weak cosine, lists disagree") could not flag 70% of negatives at any τ on the tune split. The shipped rule flags when the top result lacks some query words and its cosine is below τ = 0.60 (nomic-embed-text, chosen on tune). The τ is stored with the embedding space.
- **Version rule tuned (plan 04 §6.4 started at Jaccard 0.6).** Short documents edited throughout share few 5-word shingles (the fixture Acme versions: 0.14–0.25). Shipped tiers:
  - same name stem and Jaccard ≥ 0.1;
  - names that differ only by a date or year need Jaccard ≥ 0.35, because they are usually a dated series (meeting notes, status reports);
  - partly matching names need Jaccard ≥ 0.4;
  - text alone needs Jaccard ≥ 0.85.

  Numbers other than version markers stay in names, so "sprint 12" and "sprint 13" don't count as the same name. Neighbouring thresholds give the same results on this set (see the rule table in the report).
- **Version groups are computed at search time** from signatures and LSH bands, not stored in a `version_groups` table. They aren't user-correctable yet (05 §4.11).
- **Progress fix:** contents that fail embedding now count as processed, so indexing progress completes instead of waiting on them forever.

## Not done or not verified

- Two of the 07 §5.4 Stage 4 gates are not met (above). The holdout split has 5 negative and 34 answerable queries, so ±1 query moves these rates by 0.2 and 0.03.
- The corpus and queries are synthetic, written in one pass; the private real-world corpus (D-09) has not been run.
- Low-confidence for other embedding models stays off until each model is calibrated.
- OCR is English only. Scans are capped at 30 pages and 5 minutes per file.
