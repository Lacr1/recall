import type {
  AppStatus,
  DocumentView,
  EngineEvent,
  FailureItem,
  FolderInfo,
  FolderSuggestion,
  SearchResponse,
  SuggestedFolderId
} from '../shared/types'
import type { MicProblemCode, VoiceSettings, VoiceStatus } from '../shared/voice'

export type ActionResult = { ok: true } | { ok: false; code: string; message: string }

/** The only surface the renderer has. Every call goes through validated IPC in main. */
export interface RecallApi {
  getStatus(): Promise<AppStatus>
  search(requestId: number, query: string): Promise<SearchResponse | null>
  /** Example searches built from the user's own recent files; empty until some files have been read. */
  getSearchSuggestions(): Promise<string[]>
  getDocument(fileId: number): Promise<DocumentView | null>
  listFailures(): Promise<FailureItem[]>
  addFolder(): Promise<{ folder?: FolderInfo; error?: string; cancelled?: boolean }>
  getFolderSuggestions(): Promise<FolderSuggestion[]>
  addSuggestedFolder(id: SuggestedFolderId): Promise<{ folder?: FolderInfo; error?: string }>
  removeFolder(folderId: number): Promise<void>
  rescanFolder(folderId: number): Promise<void>
  retryFailed(): Promise<number>
  setPaused(paused: boolean): Promise<void>
  pullModel(): Promise<void>
  startOllama(): Promise<ActionResult>
  openOllamaDownload(): Promise<void>
  ask(askId: number, question: string): Promise<void>
  cancelAsk(askId: number): Promise<void>
  openFile(fileId: number): Promise<ActionResult>
  revealFile(fileId: number): Promise<ActionResult>
  copyPath(fileId: number): Promise<ActionResult>
  deleteAllData(): Promise<void>
  getDataInfo(): Promise<{ path: string; bytes: number }>
  rebuildIndex(): Promise<void>
  restartEngine(): Promise<void>
  getVoiceStatus(): Promise<VoiceStatus>
  setVoiceSettings(patch: Partial<VoiceSettings>): Promise<VoiceStatus>
  /** Mic level events for the meter in onboarding and Settings. */
  setVoiceMeter(on: boolean): Promise<void>
  /** Reports whether the microphone opened; called by the capture module. */
  voiceCapture(result: { ok: true } | { code: MicProblemCode }): Promise<void>
  openMicSettings(): Promise<void>
  /** Onboarding shows the window as just the setup card; the app is the normal resizable window. */
  setWindowMode(mode: 'onboarding' | 'app'): Promise<void>
  /** The custom title bar's buttons (the window has no Windows frame). */
  windowControl(action: 'minimize' | 'maximize' | 'close'): Promise<void>
  onEvent(listener: (e: EngineEvent) => void): () => void
}

declare global {
  interface Window {
    recall: RecallApi
  }
}
