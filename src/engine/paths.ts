import path from 'node:path'
import { MAX_DATA_BYTES, MAX_FILE_BYTES, MAX_PDF_BYTES, MAX_TEXT_BYTES } from '../shared/constants'

export type Kind = 'text' | 'markdown' | 'code' | 'pdf' | 'docx' | 'image'

const KIND_BY_EXT: Record<string, Kind> = {
  txt: 'text', log: 'text', text: 'text',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  pdf: 'pdf',
  docx: 'docx'
}

const CODE_EXTS = new Set(
  ('js jsx ts tsx mjs cjs py java cs go rs rb php kt swift c h cpp hpp cc sql sh ps1 psm1 bat cmd html htm css scss ' +
    'json yaml yml toml ini xml csv vue svelte lua r dart scala').split(' ')
)

/** Read with OCR, and only indexed while OCR is on (S4-06). */
const IMAGE_EXTS = new Set('png jpg jpeg bmp tif tiff webp'.split(' '))

export function kindForExt(ext: string, opts: { ocr?: boolean } = {}): Kind | undefined {
  if (KIND_BY_EXT[ext]) return KIND_BY_EXT[ext]
  if (CODE_EXTS.has(ext)) return 'code'
  if (opts.ocr && IMAGE_EXTS.has(ext)) return 'image'
  return undefined
}

// Directories never worth indexing; matched by name anywhere in the tree.
const EXCLUDED_DIRS = new Set([
  '.git', '.svn', '.hg', 'node_modules', '.venv', 'venv', 'env', '__pycache__', '.next', '.nuxt', 'dist', 'build', 'out',
  'target', 'bin', 'obj', '.idea', '.vscode', '.cache', 'coverage', '$recycle.bin', 'system volume information',
  'vendor', 'bower_components', 'jspm_packages', 'site-packages', 'pods', 'deriveddata', 'storybook-static',
  'appdata', '__macosx', 'temp', 'tmp', 'logs'
])

export function isExcludedDir(name: string): boolean {
  const lower = name.toLowerCase()
  return EXCLUDED_DIRS.has(lower) || lower.startsWith('.')
}

// Generated files with an indexed extension: lockfiles and minified or bundled output.
const EXCLUDED_FILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'composer.lock'])
const GENERATED_FILE = /\.(min|bundle|chunk)\.(js|mjs|cjs|css)$/

export function isExcludedFile(name: string): boolean {
  // Office lock files and hidden dotfiles.
  if (name.startsWith('~$') || name.startsWith('.')) return true
  const lower = name.toLowerCase()
  return EXCLUDED_FILES.has(lower) || GENERATED_FILE.test(lower)
}

const DATA_EXTS = new Set('log csv json xml sql'.split(' '))

/** Size above which a file is skipped as too large. */
export function sizeCapFor(kind: Kind, ext: string): number {
  if (kind === 'pdf') return MAX_PDF_BYTES
  if (kind === 'docx' || kind === 'image') return MAX_FILE_BYTES
  return DATA_EXTS.has(ext) ? MAX_DATA_BYTES : MAX_TEXT_BYTES
}

/** Windows paths are case-insensitive, so keys are lower-cased. */
export function pathKey(p: string): string {
  return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase()
}

export function isInsideRoot(candidate: string, root: string): boolean {
  const rel = path.relative(pathKey(root), pathKey(candidate))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Rejects UNC/device paths, alternate data streams and NUL bytes. */
export function isSafeLocalPath(p: string): boolean {
  if (p.includes('\0')) return false
  if (p.startsWith('\\\\') || p.startsWith('//')) return false
  // A colon is only allowed as the drive separator ("C:").
  if (p.indexOf(':', 2) !== -1) return false
  return /^[a-zA-Z]:[\\/]/.test(p)
}

const BLOCKED_ROOTS = ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)', 'c:\\programdata']

export function isBlockedFolder(p: string): string | undefined {
  const key = pathKey(p)
  if (/^[a-z]:$/.test(key)) return 'Whole drives cannot be added. Choose a folder instead.'
  if (BLOCKED_ROOTS.some((r) => key === r || key.startsWith(r + '\\'))) return 'System folders cannot be added.'
  const appData = process.env.APPDATA?.toLowerCase()
  const localAppData = process.env.LOCALAPPDATA?.toLowerCase()
  if ((appData && key.startsWith(appData)) || (localAppData && key.startsWith(localAppData)))
    return 'Application data folders cannot be added.'
  return undefined
}

/** Splits names like "Acme_ProposalV3-final.docx" into searchable words. */
export function tokenizeName(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')
    .replace(/[_\-.()[\]{}]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function tokenizePath(relPath: string): string {
  const dirs = path.dirname(relPath)
  if (dirs === '.') return ''
  return dirs.split(/[\\/]/).map(tokenizeName).join(' ')
}

// Extensions that Windows may execute when "opened". Recall never launches these.
const OPENABLE = new Set(
  'txt log md markdown pdf docx doc rtf odt pptx xlsx csv png jpg jpeg gif webp bmp tiff'.split(' ')
)

export function isSafeToOpen(ext: string): boolean {
  return OPENABLE.has(ext.toLowerCase())
}
