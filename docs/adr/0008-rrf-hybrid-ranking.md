# ADR-0008: Reciprocal Rank Fusion, plus an all-terms list and a meaning margin

**Status:** Amended (2026-10-09). This extends the plan's baseline based on eval results.

**Context.** The plan's baseline used RRF (k = 60) to combine three lists: any-term keyword matches, meaning (vector) matches and file names. On the eval set, two problems showed up:
- exact-phrase queries lost to noisy any-term matches;
- meaning search padded every result list with weak neighbours.

**Decision.**
1. Add a fourth ranked list: chunks containing **all** query terms (FTS5 AND), fused at chunk level alongside the others.
2. Drop results found **only** by meaning when their cosine is more than 0.10 below the best match.
3. Flag a search as low confidence when all three hold:
   - the top result covers less than half the query terms;
   - its cosine is below 0.62 (calibrated for nomic-embed-text);
   - the keyword and meaning lists disagree.

**Evidence.** `npm run test:live` on 25 queries:
- hybrid MRR@10 rose from 0.85 to 0.95, with Hit@5 staying at 1.00;
- average results per query fell from 15.0 to 8.4;
- the low-confidence rule flags 3 of 5 negative queries and 0 of 20 answerable ones, below the plan's 0.7 target for negatives.

**Open.** Re-tune on the 80-query set (S1-11) and on real folders. The thresholds are specific to the embedding model.
