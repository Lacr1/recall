import type { ExtractResult } from './extract'
import type { Kind } from './paths'

export interface Chunk {
  text: string
  start: number
  end: number
  pageStart?: number
  pageEnd?: number
  section?: string
}

export interface ChunkConfig {
  target: number
  max: number
  min: number
  overlap: number
}

// Starting values from plan doc 04 §3.2; tuned with the eval harness later.
export const PROSE_CONFIG: ChunkConfig = { target: 1200, max: 2400, min: 200, overlap: 180 }
export const CODE_CONFIG: ChunkConfig = { target: 1600, max: 2400, min: 120, overlap: 120 }

/**
 * Structure-first chunking: headings (level <= 3) start new chunks, paragraphs are packed
 * up to the target size, and size-based splits overlap by whole sentences. Every chunk is an
 * exact slice of the extracted text so offsets map back to the document.
 */
export function chunkDocument(doc: ExtractResult, kind: Kind, cfg = kind === 'code' ? CODE_CONFIG : PROSE_CONFIG): Chunk[] {
  const { text } = doc
  const chunks: Chunk[] = []
  const headings: { level: number; text: string }[] = []
  let cur: { start: number; end: number; pageStart?: number; pageEnd?: number; section?: string } | undefined

  const sectionPath = () => (headings.length ? headings.map((h) => h.text).join(' › ') : undefined)

  const emit = (start: number, end: number, pageStart?: number, pageEnd?: number, section?: string) => {
    ;[start, end] = trimRange(text, start, end)
    if (end <= start) return
    const prev = chunks[chunks.length - 1]
    if (end - start < cfg.min && prev && prev.section === section && end - prev.start <= cfg.max && start <= prev.end + 4) {
      prev.end = Math.max(prev.end, end)
      prev.text = text.slice(prev.start, prev.end)
      prev.pageEnd = pageEnd ?? prev.pageEnd
      return
    }
    chunks.push({ text: text.slice(start, end), start, end, pageStart, pageEnd, section })
  }

  const flush = () => {
    if (cur) emit(cur.start, cur.end, cur.pageStart, cur.pageEnd, cur.section)
    cur = undefined
  }

  for (const block of doc.blocks) {
    if (block.heading !== undefined) {
      const headingText = text.slice(block.start, block.end).replace(/^#+\s*/, '').trim()
      if (block.heading <= 3) {
        flush()
        while (headings.length && headings[headings.length - 1].level >= block.heading) headings.pop()
        headings.push({ level: block.heading, text: headingText })
      }
      cur ??= { start: block.start, end: block.end, pageStart: block.page, pageEnd: block.page, section: sectionPath() }
      cur.end = block.end
      continue
    }

    if (block.end - block.start > cfg.max) {
      // Oversized paragraph: emit what we have, then split the block itself.
      const headStart = cur?.start
      flush()
      let pos = headStart !== undefined && block.start - headStart < cfg.target / 2 ? headStart : block.start
      while (pos < block.end) {
        const cut = findCut(text, pos, block.end, cfg)
        emit(pos, cut, block.page, block.page, sectionPath())
        if (cut >= block.end) break
        pos = Math.max(pos + 1, overlapStart(text, cut, cfg.overlap))
      }
      continue
    }

    if (cur && block.end - cur.start > cfg.target) {
      const prevEnd = cur.end
      flush()
      const ov = overlapStart(text, prevEnd, cfg.overlap)
      cur = { start: ov < prevEnd ? ov : block.start, end: block.end, pageStart: block.page, pageEnd: block.page, section: sectionPath() }
      continue
    }

    cur ??= { start: block.start, end: block.end, pageStart: block.page, pageEnd: block.page, section: sectionPath() }
    cur.end = block.end
    cur.pageEnd = block.page ?? cur.pageEnd
  }
  flush()
  return chunks
}

function trimRange(text: string, start: number, end: number): [number, number] {
  while (start < end && /\s/.test(text[start])) start++
  while (end > start && /\s/.test(text[end - 1])) end--
  return [start, end]
}

/** Picks a cut point near the target at a sentence end, else whitespace, never beyond max. */
function findCut(text: string, pos: number, limit: number, cfg: ChunkConfig): number {
  if (limit - pos <= cfg.target) return limit
  const lo = pos + Math.floor(cfg.target / 2)
  const hi = Math.min(pos + cfg.target, limit)
  const window = text.slice(lo, hi)
  let best = -1
  const sentence = /[.!?]["')\]]?\s+/g
  for (let m = sentence.exec(window); m; m = sentence.exec(window)) best = lo + m.index + m[0].length
  if (best > 0) return best
  const ws = text.lastIndexOf(' ', hi)
  if (ws > lo) return ws + 1
  return Math.min(pos + cfg.max, limit)
}

/** Start of the trailing whole sentence(s) within `overlap` chars before `end`. */
function overlapStart(text: string, end: number, overlap: number): number {
  const from = Math.max(0, end - overlap)
  const window = text.slice(from, end)
  const m = /[.!?]["')\]]?\s+/.exec(window)
  if (!m) return end
  const start = from + m.index + m[0].length
  return start < end ? start : end
}

/** Text sent to the embedding model: required prefix + document context + chunk. */
export function embeddingText(prefix: string, chunk: { text: string; section?: string | null }, title?: string | null): string {
  const header = [title, chunk.section].filter(Boolean).join(' › ')
  return prefix + (header ? header + '\n\n' : '') + chunk.text
}
