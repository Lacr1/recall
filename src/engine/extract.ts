import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { Kind } from './paths'

/** A structural unit of extracted text. Offsets index into ExtractResult.text. */
export interface Block {
  start: number
  end: number
  heading?: number // heading level 1-6 when the block is a heading
  page?: number
}

export interface ExtractResult {
  text: string
  blocks: Block[]
  title?: string
  pageCount?: number
  truncated: boolean
}

export class ExtractError extends Error {
  constructor(readonly code: 'password_protected' | 'corrupt' | 'no_text' | 'binary' | 'timeout' | 'failed', message?: string) {
    super(message ?? code)
  }
}

const MAX_CHARS = 2_000_000
const TIMEOUT_MS = 60_000

export async function extractFile(filePath: string, kind: Kind): Promise<ExtractResult> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ExtractError('timeout')), TIMEOUT_MS)
  })
  try {
    return await Promise.race([extractByKind(filePath, kind), timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function extractByKind(filePath: string, kind: Kind): Promise<ExtractResult> {
  const buf = await readFile(filePath)
  switch (kind) {
    case 'pdf':
      return extractPdf(buf)
    case 'docx':
      return extractDocx(buf)
    case 'markdown':
      return fromBlocks(splitMarkdown(decodeText(buf)))
    case 'code':
      return fromBlocks(splitParagraphs(decodeText(buf)))
    case 'text':
      return fromBlocks(splitParagraphs(decodeText(buf)))
  }
}

// ---------- plain text ----------

export function decodeText(buf: Buffer): string {
  let text: string
  if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.subarray(2).toString('utf16le')
  else if (buf[0] === 0xfe && buf[1] === 0xff) text = Buffer.from(buf.subarray(2)).swap16().toString('utf16le')
  else {
    const head = buf.subarray(0, 8192)
    if (head.includes(0)) throw new ExtractError('binary')
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
    } catch {
      text = new TextDecoder('windows-1252').decode(buf)
    }
  }
  return normalize(text)
}

export function normalize(text: string): string {
  return text
    .replace(/^﻿/, '')
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
}

interface Draft {
  text: string
  blocks: Block[]
  title?: string
  pageCount?: number
}

function fromBlocks(d: Draft): ExtractResult {
  let { text, blocks } = d
  let truncated = false
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS)
    blocks = blocks.filter((b) => b.start < MAX_CHARS).map((b) => ({ ...b, end: Math.min(b.end, MAX_CHARS) }))
    truncated = true
  }
  return { text, blocks, title: d.title, pageCount: d.pageCount, truncated }
}

/** Paragraphs separated by blank lines. Also used for code (blank-line separated blocks). */
export function splitParagraphs(text: string, page?: number, offset = 0): Draft {
  const blocks: Block[] = []
  const re = /\S[\s\S]*?(?=\n\s*\n|$)/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    blocks.push({ start: offset + m.index, end: offset + m.index + m[0].trimEnd().length, page })
  }
  return { text, blocks }
}

export function splitMarkdown(text: string): Draft {
  const blocks: Block[] = []
  let title: string | undefined
  let inFence = false
  let paraStart = -1
  let pos = 0
  const flush = (end: number) => {
    if (paraStart >= 0) {
      const slice = text.slice(paraStart, end)
      if (slice.trim()) blocks.push({ start: paraStart, end: paraStart + slice.trimEnd().length })
      paraStart = -1
    }
  }
  for (const line of text.split('\n')) {
    const lineStart = pos
    pos += line.length + 1
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    const heading = !inFence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      flush(lineStart)
      blocks.push({ start: lineStart, end: lineStart + line.length, heading: heading[1].length })
      if (!title && heading[1].length === 1) title = heading[2]
    } else if (!inFence && line.trim() === '') {
      flush(lineStart)
    } else if (paraStart < 0) {
      paraStart = lineStart
    }
  }
  flush(text.length)
  return { text, blocks, title }
}

// ---------- PDF ----------

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
let pdfjsPromise: Promise<PdfJs> | undefined

function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((m) => {
    const req = createRequire(import.meta.url)
    m.GlobalWorkerOptions.workerSrc = pathToFileURL(req.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href
    return m
  })
  return pdfjsPromise
}

async function extractPdf(buf: Buffer): Promise<ExtractResult> {
  const pdfjs = await loadPdfJs()
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0
  })
  let doc
  try {
    doc = await task.promise
  } catch (err) {

    const name = (err as { name?: string })?.name
    if (name === 'PasswordException') throw new ExtractError('password_protected')
    throw new ExtractError('corrupt')
  }
  try {
    let text = ''
    const blocks: Block[] = []
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const content = await page.getTextContent()
      let pageText = ''
      for (const item of content.items) {
        if (!('str' in item)) continue
        pageText += item.str
        if (item.hasEOL) pageText += '\n'
        else if (item.str && !item.str.endsWith(' ')) pageText += ' '
      }
      pageText = reflowPdfPage(normalize(pageText))
      if (pageText.trim()) {
        if (text) text += '\n\n'
        const draft = splitParagraphs(pageText, p, text.length)
        blocks.push(...draft.blocks)
        text += pageText
      }
      page.cleanup()
      if (text.length > MAX_CHARS) break
    }
    if (!text.trim()) throw new ExtractError('no_text', 'No text layer (possibly scanned)')
    let title: string | undefined
    try {
      const meta = await doc.getMetadata()
      const t = (meta.info as { Title?: unknown })?.Title
      if (typeof t === 'string' && t.trim()) title = t.trim()
    } catch {
      // Metadata is optional.
    }
    return fromBlocks({ text, blocks, title, pageCount: doc.numPages })
  } finally {
    await task.destroy()
  }
}

/** Joins hyphenated line breaks and single line breaks inside paragraphs. */
export function reflowPdfPage(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/(\w)-\n(\w)/g, '$1$2')
    .replace(/([^\n.!?:;])\n(?=[a-z0-9(])/g, '$1 ')
    .replace(/[ \t]{2,}/g, ' ')
}

// ---------- DOCX ----------

async function extractDocx(buf: Buffer): Promise<ExtractResult> {
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new ExtractError('corrupt', 'Not a ZIP container')
  const mammoth = await import('mammoth')
  let html: string
  try {
    html = (await mammoth.convertToHtml({ buffer: buf })).value
  } catch {
    throw new ExtractError('corrupt')
  }
  let text = ''
  const blocks: Block[] = []
  let title: string | undefined
  const re = /<(h[1-6]|p|li|tr)\b[^>]*>([\s\S]*?)<\/\1>/g
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const tag = m[1]
    const inner = tag === 'tr' ? m[2].replace(/<\/t[dh]>\s*<t[dh][^>]*>/g, '\t') : m[2]
    const blockText = normalize(decodeEntities(inner.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, ''))).trim()
    if (!blockText) continue
    if (text) text += '\n\n'
    const start = text.length
    text += blockText
    const heading = tag.startsWith('h') ? Number(tag[1]) : undefined
    if (heading === 1 && !title) title = blockText
    blocks.push({ start, end: text.length, heading })
  }
  if (!text.trim()) throw new ExtractError('no_text')
  return fromBlocks({ text, blocks, title })
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
}
