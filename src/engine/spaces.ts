import type { DB } from './db'

// Plan doc 05 §4.7 / 04 §5.5 (S4-07). Vectors from different models (or different weights under the same
// name) are not comparable, so each model gets its own embedding space. Exactly one space is active and
// serves search; a model change builds a second space in the background and swaps in one transaction.

export interface EmbeddingSpace {
  id: number
  model: string
  digest: string | null
  dims: number | null
  docPrefix: string
  queryPrefix: string
  /** Calibrated low-confidence cosine for this model; null until calibrated, which turns the flag off. */
  lowConfidenceCosine: number | null
  status: 'active' | 'building' | 'retired'
}

// Task prefixes some embedding models were trained with; models not listed get none.
const PREFIXES: Record<string, { doc: string; query: string }> = {
  'nomic-embed-text': { doc: 'search_document: ', query: 'search_query: ' },
  'mxbai-embed-large': { doc: '', query: 'Represent this sentence for searching relevant passages: ' },
  'snowflake-arctic-embed': { doc: '', query: 'Represent this sentence for searching relevant passages: ' }
}

// Low-confidence thresholds per model, calibrated on the Stage 4 eval's tune split (eval-results/s4-eval.md).
const CALIBRATED_COSINE: Record<string, number> = { 'nomic-embed-text': 0.6 }

/** "nomic-embed-text:latest" → "nomic-embed-text" */
export function baseModel(name: string): string {
  return name.replace(/:latest$/, '')
}

export function prefixesFor(model: string): { doc: string; query: string } {
  return PREFIXES[baseModel(model).split(':')[0]] ?? { doc: '', query: '' }
}

const SELECT = `SELECT id, model, model_digest digest, dims, doc_prefix docPrefix, query_prefix queryPrefix,
  low_conf_cosine lowConfidenceCosine, status FROM embedding_spaces`

export function activeSpace(db: DB): EmbeddingSpace {
  return db.prepare(`${SELECT} WHERE status = 'active'`).get() as EmbeddingSpace
}

export function buildingSpace(db: DB): EmbeddingSpace | undefined {
  return db.prepare(`${SELECT} WHERE status = 'building'`).get() as EmbeddingSpace | undefined
}

/** Records the model's digest and dimensions the first time they are known. */
export function noteSpaceFacts(db: DB, spaceId: number, facts: { digest?: string; dims?: number }): void {
  if (facts.digest) db.prepare('UPDATE embedding_spaces SET model_digest = ? WHERE id = ? AND model_digest IS NULL').run(facts.digest, spaceId)
  if (facts.dims) db.prepare('UPDATE embedding_spaces SET dims = ? WHERE id = ? AND dims IS NULL').run(facts.dims, spaceId)
}

/** Starts building a space for `model`, replacing any build already under way. */
export function startBuild(db: DB, model: string, digest: string | null): EmbeddingSpace {
  const name = baseModel(model)
  const p = prefixesFor(name)
  db.transaction(() => {
    db.prepare("DELETE FROM embedding_spaces WHERE status IN ('building','retired')").run()
    db.prepare(
      `INSERT INTO embedding_spaces(model, model_digest, doc_prefix, query_prefix, low_conf_cosine, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'building', ?)`
    ).run(name, digest, p.doc, p.query, CALIBRATED_COSINE[name] ?? null, Date.now())
  })()
  return buildingSpace(db)!
}

export function cancelBuild(db: DB): boolean {
  return db.prepare("DELETE FROM embedding_spaces WHERE status = 'building'").run().changes > 0
}

/**
 * The atomic swap: the building space becomes active and the old one is deleted with its vectors (FK cascade).
 * Embed status moves with it: contents are 'done' in the new space when every chunk has a vector there.
 */
export function activateBuilding(db: DB, failedContents: Set<number>): EmbeddingSpace {
  db.transaction(() => {
    const next = buildingSpace(db)
    if (!next) throw new Error('No embedding space is being built')
    db.prepare("UPDATE embedding_spaces SET status = 'retired' WHERE status = 'active'").run()
    db.prepare("UPDATE embedding_spaces SET status = 'active', activated_at = ? WHERE id = ?").run(Date.now(), next.id)
    db.prepare("DELETE FROM embedding_spaces WHERE status = 'retired'").run()
    db.prepare(
      `UPDATE contents SET embed_status = CASE
         WHEN NOT EXISTS (SELECT 1 FROM chunks ch LEFT JOIN chunk_vectors v ON v.chunk_id = ch.id AND v.space_id = ?
                          WHERE ch.content_id = contents.id AND v.chunk_id IS NULL) THEN 'done'
         ELSE 'pending' END
       WHERE extract_status = 'ok' AND chunk_count > 0`
    ).run(next.id)
    const fail = db.prepare("UPDATE contents SET embed_status = 'failed' WHERE id = ? AND embed_status = 'pending'")
    for (const id of failedContents) fail.run(id)
  })()
  return activeSpace(db)
}
