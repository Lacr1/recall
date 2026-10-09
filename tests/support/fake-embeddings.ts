import { EMBED_DIMS } from '../../src/shared/constants'

/**
 * Deterministic stand-in for the embedding model: hashed word features, L2-normalised.
 * Texts sharing words get similar vectors, which is enough to exercise the pipeline.
 */
export function fakeEmbed(text: string): number[] {
  const v = new Array<number>(EMBED_DIMS).fill(0)
  const words = text.toLowerCase().replace(/^search_(query|document): /, '').match(/[a-z0-9]+/g) ?? []
  for (const w of words) {
    let h = 2166136261
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619)
    v[Math.abs(h) % EMBED_DIMS] += 1
  }
  const norm = Math.hypot(...v) || 1
  return v.map((x) => x / norm)
}
