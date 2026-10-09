import { describe, expect, it } from 'vitest'
import { chunkDocument, embeddingText } from '../../src/engine/chunk'
import { decodeText, splitMarkdown, splitParagraphs } from '../../src/engine/extract'
import { ftsQuery, fuse, makeSnippet } from '../../src/engine/search'
import { findTerms, queryTerms } from '../../src/shared/text'
import {
  isExcludedDir, isExcludedFile, isInsideRoot, isSafeLocalPath, isSafeToOpen, sizeCapFor, tokenizeName
} from '../../src/engine/paths'
import { MAX_DATA_BYTES, MAX_FILE_BYTES, MAX_PDF_BYTES, MAX_TEXT_BYTES } from '../../src/shared/constants'

const longParagraph = (n: number, word = 'payment') =>
  Array.from({ length: n }, (_, i) => `Sentence ${i} talks about the ${word} schedule in detail.`).join(' ')

describe('chunker', () => {
  it('produces exact slices of the source text', () => {
    const text = [longParagraph(40), longParagraph(30, 'warranty'), longParagraph(5)].join('\n\n')
    const doc = { ...splitParagraphs(text), truncated: false }
    const chunks = chunkDocument(doc, 'text')
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.text).toBe(text.slice(c.start, c.end))
      expect(c.text.length).toBeLessThanOrEqual(2400)
    }
  })

  it('stitching non-overlapping parts reproduces all content', () => {
    const text = [longParagraph(60), 'short tail'].join('\n\n')
    const chunks = chunkDocument({ ...splitParagraphs(text), truncated: false }, 'text')
    let cursor = 0
    let stitched = ''
    for (const c of chunks) {
      const from = Math.max(cursor, c.start)
      if (cursor > 0 && c.start > cursor) stitched += text.slice(cursor, c.start)
      stitched += text.slice(from, c.end)
      cursor = c.end
    }
    expect(stitched.trim()).toBe(text.trim())
  })

  it('starts new chunks at headings and records the section path', () => {
    const md = '# Proposal\n\nIntro text.\n\n## Payment terms\n\nWe propose a 50% initial payment.\n\n## Timeline\n\nStarts in March.'
    const chunks = chunkDocument({ ...splitMarkdown(md), truncated: false }, 'markdown')
    const payment = chunks.find((c) => c.text.includes('50%'))!
    expect(payment.section).toBe('Proposal › Payment terms')
    expect(payment.text).not.toContain('Starts in March')
  })

  it('splits a single huge line without exceeding the max size', () => {
    const text = 'x'.repeat(50_000)
    const chunks = chunkDocument({ text, blocks: [{ start: 0, end: text.length }], truncated: false }, 'text')
    expect(chunks.every((c) => c.text.length <= 2400)).toBe(true)
    expect(chunks.at(-1)!.end).toBe(text.length)
  })

  it('adds the required prefix and document context for embedding', () => {
    expect(embeddingText('search_document: ', { text: 'Body', section: 'Fees' }, 'Proposal')).toBe('search_document: Proposal › Fees\n\nBody')
  })
})

describe('text decoding', () => {
  it('handles UTF-16 LE with BOM, UTF-8 BOM, Windows-1252 and CRLF', () => {
    expect(decodeText(Buffer.from('\ufeffhéllo\r\nworld', 'utf16le').subarray(0))).toBe('héllo\nworld')
    expect(decodeText(Buffer.from('\ufeffcafé', 'utf8'))).toBe('café')
    expect(decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toBe('café')
  })

  it('rejects binary content', () => {
    expect(() => decodeText(Buffer.from([0x41, 0x00, 0x42]))).toThrow()
  })
})

describe('search helpers', () => {
  it('builds FTS queries that cannot inject syntax', () => {
    const q = ftsQuery(queryTerms('"payment" OR NEAR(x) * -foo (bar)'))!
    expect(q).toBe('"payment" OR "near" OR "foo" OR "bar"')
  })

  it('keeps numbers and drops filler words', () => {
    expect(queryTerms('Find the proposal where I discussed a 50% initial payment')).toEqual(['proposal', 'discussed', '50', 'initial', 'payment'])
  })

  it('fuses lists with reciprocal rank fusion and file-name matches', () => {
    const fused = fuse({
      keyword: [{ chunkId: 1, contentId: 10 }, { chunkId: 2, contentId: 20 }],
      vector: [{ chunkId: 2, contentId: 20, score: 0.8 }, { chunkId: 3, contentId: 30, score: 0.7 }],
      name: [{ fileId: 99, contentId: 30 }]
    })
    const order = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).map(([id]) => id)
    expect(order[0]).toBe(20) // in both chunk lists
    expect(fused.get(30)!.nameRank).toBe(1)
  })

  it('highlights word-prefix matches in the snippet', () => {
    const { snippet, highlights } = makeSnippet('We agreed on two payments and an initial deposit.', ['payment', 'initial'])
    expect(highlights.map((h) => snippet.slice(h.start, h.end))).toEqual(['payments', 'initial'])
    expect(findTerms('Payment, payment', ['payment'])).toHaveLength(2)
  })
})

describe('path safety', () => {
  it('detects paths outside a root, including prefix tricks', () => {
    expect(isInsideRoot('C:\\Docs\\a.txt', 'C:\\Docs')).toBe(true)
    expect(isInsideRoot('C:\\Docs2\\a.txt', 'C:\\Docs')).toBe(false)
    expect(isInsideRoot('C:\\Docs\\..\\Windows\\x', 'C:\\Docs')).toBe(false)
    expect(isInsideRoot('c:\\docs\\A.TXT', 'C:\\Docs')).toBe(true)
  })

  it('rejects UNC, device, ADS and NUL paths', () => {
    expect(isSafeLocalPath('C:\\Docs\\a.txt')).toBe(true)
    expect(isSafeLocalPath('\\\\server\\share\\a.txt')).toBe(false)
    expect(isSafeLocalPath('\\\\?\\C:\\a.txt')).toBe(false)
    expect(isSafeLocalPath('C:\\Docs\\a.txt:hidden')).toBe(false)
    expect(isSafeLocalPath('C:\\Docs\\a.txt\0.pdf')).toBe(false)
  })

  it('never opens executable or script types', () => {
    for (const ext of ['exe', 'bat', 'cmd', 'ps1', 'js', 'vbs', 'lnk', 'url', 'hta', 'msi']) expect(isSafeToOpen(ext)).toBe(false)
    for (const ext of ['pdf', 'docx', 'md', 'txt']) expect(isSafeToOpen(ext)).toBe(true)
  })

  it('splits file names into words', () => {
    expect(tokenizeName('Acme_ProposalV3-final.docx')).toBe('Acme Proposal V 3 final')
  })
})

describe('indexing rules', () => {
  it('skips dependency, cache and app-data folders', () => {
    for (const d of ['node_modules', 'vendor', 'site-packages', 'AppData', 'Temp', '.gradle']) expect(isExcludedDir(d)).toBe(true)
    for (const d of ['Documents', 'clients', 'src']) expect(isExcludedDir(d)).toBe(false)
  })

  it('skips lockfiles and minified or bundled output', () => {
    for (const f of ['package-lock.json', 'pnpm-lock.yaml', 'jquery.min.js', 'app.bundle.js', 'site.MIN.css', '~$report.docx'])
      expect(isExcludedFile(f)).toBe(true)
    for (const f of ['package.json', 'session.ts', 'notes.md', 'mint.js']) expect(isExcludedFile(f)).toBe(false)
  })

  it('caps plain-text and data files well below documents', () => {
    expect(sizeCapFor('pdf', 'pdf')).toBe(MAX_PDF_BYTES)
    expect(sizeCapFor('docx', 'docx')).toBe(MAX_FILE_BYTES)
    expect(sizeCapFor('code', 'ts')).toBe(MAX_TEXT_BYTES)
    expect(sizeCapFor('text', 'log')).toBe(MAX_DATA_BYTES)
    expect(sizeCapFor('code', 'csv')).toBe(MAX_DATA_BYTES)
  })
})
