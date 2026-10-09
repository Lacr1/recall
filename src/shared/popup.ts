// What main shows in the voice popup and what the popup may ask back (plan 12 §5.1).
// The wording lives in the popup's copy deck (src/shared/popup-copy.ts); main sends only data.

export interface PopupItem {
  /** Index id for files (actions go through the open-file guard); absent for folders. */
  fileId?: number
  name: string
  /** Folder the item is in, for display. */
  dir: string
  ext: string
  isFolder: boolean
}

export interface PopupSource {
  n: number
  fileId: number
  name: string
  location?: string
}

export type PopupProblem =
  | 'noMatch'
  | 'notInFiles'
  | 'didntCatch'
  | 'needsModel'
  | 'needsAi'
  | 'micProblem'
  | 'answerFailed'
  | 'busy'

export type PopupView =
  | { kind: 'prompt' }
  | { kind: 'awaitRequest' }
  | { kind: 'working'; heard: string; mode: 'file' | 'folder' | 'question'; query: string }
  /** weak: nothing matched strongly, so nothing is copied until the user picks one. */
  | { kind: 'files'; heard: string; query: string; items: PopupItem[]; selected: number; copied: boolean; weak: boolean; indexing: boolean }
  | { kind: 'answer'; heard: string; text: string; streaming: boolean; sources: PopupSource[]; indexing: boolean }
  | { kind: 'problem'; heard?: string; query?: string; problem: PopupProblem }

export interface PopupState {
  view: PopupView
  /** Read-aloud is on and a reply is being, or can be, spoken. */
  speech: { enabled: boolean; speaking: boolean }
  /** Increases every time the popup is shown, so the prompt wording can rotate. */
  showCount: number
}

export type PopupAction =
  | { type: 'dismiss' }
  | { type: 'select'; index: number }
  | { type: 'reveal' }
  | { type: 'openInRecall' }
  | { type: 'openSource'; fileId: number }
  | { type: 'openSettings' }
  | { type: 'openMicSettings' }
  | { type: 'hover'; on: boolean }
  | { type: 'speaking'; on: boolean }
  | { type: 'stopSpeech' }
  | { type: 'resize'; height: number }

export const POPUP_WIDTH = 400
export const POPUP_MAX_HEIGHT = 480

/** Validates an action coming from the popup renderer; anything malformed is dropped. */
export function parsePopupAction(raw: unknown): PopupAction | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const a = raw as Record<string, unknown>
  const int = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : undefined)
  switch (a.type) {
    case 'dismiss':
    case 'reveal':
    case 'openInRecall':
    case 'openSettings':
    case 'openMicSettings':
    case 'stopSpeech':
      return { type: a.type }
    case 'select': {
      const index = int(a.index)
      return index === undefined || index > 10 ? undefined : { type: 'select', index }
    }
    case 'openSource': {
      const fileId = int(a.fileId)
      return fileId === undefined ? undefined : { type: 'openSource', fileId }
    }
    case 'hover':
    case 'speaking':
      return typeof a.on === 'boolean' ? { type: a.type, on: a.on } : undefined
    case 'resize': {
      const h = Number(a.height)
      return Number.isFinite(h) && h > 0 ? { type: 'resize', height: Math.min(Math.ceil(h), POPUP_MAX_HEIGHT) } : undefined
    }
    default:
      return undefined
  }
}

/** What the popup's preload exposes as window.recallPopup. */
export interface RecallPopupApi {
  onState(listener: (s: PopupState) => void): () => void
  onLevel(listener: (rms: number) => void): () => void
  action(a: PopupAction): Promise<void>
}
