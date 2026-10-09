// DTOs shared by engine, main, preload and renderer. Plain data only.
import type { VoiceStatus } from './voice'

export type AiState = 'checking' | 'not_installed' | 'not_running' | 'model_missing' | 'pulling' | 'ready'

export interface AiStatus {
  state: AiState
  ollamaVersion?: string
  embedModel: string
  chatModel: string
  chatAvailable: boolean
  pull?: { completed: number; total: number; status: string }
  error?: string
}

/** Well-known Windows folders offered as one-click picks; main resolves the id to a path. */
export type SuggestedFolderId = 'documents' | 'desktop' | 'downloads'

export interface FolderSuggestion {
  id: SuggestedFolderId
  label: string
  path: string
}

export interface FolderInfo {
  id: number
  path: string
  status: 'active' | 'unavailable'
  fileCount: number
  skippedCount: number
  failedCount: number
}

export interface IndexProgress {
  paused: boolean
  scanning: boolean
  filesTotal: number
  filesPending: number
  readDone: number
  readTotal: number
  embedDone: number
  embedTotal: number
  skipped: number
  failed: number
  chunks: number
}

export type IndexProblemCode = 'damaged' | 'newer_version' | 'migration_failed' | 'cannot_open'

export interface AppStatus {
  ai: AiStatus
  progress: IndexProgress
  folders: FolderInfo[]
  /** The index can't be used; the engine runs in problem mode and only offers a rebuild (plan doc 02 §5.13). */
  problem?: { code: IndexProblemCode; message: string }
  /** The index was rebuilt from the saved folder list on this start. */
  rebuilt?: boolean
}

export interface HighlightRange {
  start: number
  end: number
}

export interface Evidence {
  chunkId: number
  snippet: string
  highlights: HighlightRange[]
  location?: string
}

export interface FileRef {
  fileId: number
  name: string
  path: string
  folderPath: string
  ext: string
  size: number
  mtimeMs: number
}

export type MatchReason =
  | { kind: 'terms'; terms: string[] }
  | { kind: 'meaning'; location?: string }
  | { kind: 'filename' }

export interface SearchResult {
  contentId: number
  primary: FileRef
  copies: FileRef[]
  title?: string
  evidence: Evidence[]
  reasons: MatchReason[]
  debug?: { score: number; kwRank?: number; vecRank?: number; nameRank?: number; bestCosine?: number }
}

export interface SearchResponse {
  requestId: number
  query: string
  mode: 'hybrid' | 'keyword'
  modeReason?: string
  tookMs: number
  results: SearchResult[]
  lowConfidence: boolean
  partialIndex: boolean
}

export interface FailureItem {
  fileId: number
  name: string
  path: string
  reason: string
}

export interface DocumentView {
  file: FileRef
  copies: FileRef[]
  title?: string
  kind: string
  status: string
  pageCount?: number
  text: string
  truncated: boolean
  changedSinceIndexed: boolean
}

export interface AskSource {
  n: number
  fileId: number
  name: string
  location?: string
  snippet: string
}

export type AskEvent =
  | { type: 'sources'; askId: number; sources: AskSource[] }
  | { type: 'token'; askId: number; text: string }
  | { type: 'done'; askId: number; insufficient: boolean; invalidCitations: number[] }
  | { type: 'error'; askId: number; message: string }

export interface RecallErrorShape {
  code: string
  message: string
}

// Engine events pushed through main to the renderer. Main adds engineRestarted (after a crash) and
// engineStopped (after repeated crashes, when it stops restarting).
export type EngineEvent =
  | { event: 'status'; data: AppStatus }
  | { event: 'ask'; data: AskEvent }
  | { event: 'engineRestarted' }
  | { event: 'engineStopped' }
  | { event: 'voice'; data: VoiceStatus }
  | { event: 'voiceWake' }
  | { event: 'voiceLevel'; rms: number }
  /** The popup's Open in Recall / Open Settings: show this view, with the spoken request filled in. */
  | { event: 'voiceOpen'; view: 'search' | 'ask' | 'settings'; text: string }
  /** The window was maximized or restored, for the title bar's button. */
  | { event: 'window'; maximized: boolean }
