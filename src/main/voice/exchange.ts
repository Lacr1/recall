// One spoken exchange at a time: wake word → popup → file path or answer (plan 12 §2, S8-06/07/08).
// The decisions come from VoiceSession; this class carries them out with the engine, the clipboard and the popup.
// File actions use index ids and the main process's open-file guard; nothing spoken is ever used as a path (SEC-16).
import { clipboard } from 'electron'
import type { AskEvent } from '../../shared/types'
import type { PopupAction, PopupItem, PopupState, PopupView } from '../../shared/popup'
import type { VoiceCommand } from '../../shared/voice'
import { VoicePopup } from './popup'
import { VoiceSession, type SessionAction } from './session'

export interface VoiceExchangeDeps {
  call<T>(method: string, params: object): Promise<T>
  voice(cmd: VoiceCommand): void
  readAloud(): boolean
  revealFile(fileId: number): Promise<void>
  revealFolder(path: string): Promise<void>
  openFile(fileId: number): Promise<void>
  openInRecall(view: 'search' | 'ask', text: string): void
  openSettings(): void
  openMicSettings(): void
  devUrl?: string
}

interface Target {
  path: string
  fileId?: number
}

type FileHit = { fileId: number; name: string; path: string; folderPath: string; ext: string }

/** Results stay up this long once the pointer is not over them (D-24). */
export const RESULT_CLOSE_MS = 60_000
// Voice asks get their own id range so they never collide with the window's Ask view.
let nextAskId = 1_000_000

export class VoiceExchange {
  private readonly session = new VoiceSession()
  private readonly popup: VoicePopup
  private view: PopupView = { kind: 'prompt' }
  private targets: Target[] = []
  private showCount = 0
  private speaking = false
  private hovered = false
  private closeTimer?: ReturnType<typeof setTimeout>
  private tickTimer?: ReturnType<typeof setInterval>
  private askId = 0
  private lastRequest?: { mode: 'search' | 'ask'; text: string }

  constructor(private readonly d: VoiceExchangeDeps) {
    this.popup = new VoicePopup((a) => this.onPopupAction(a), d.devUrl)
  }

  prepare(): void {
    this.popup.prepare()
  }

  isPopupSender(frame: Electron.WebFrameMain | null): boolean {
    return this.popup.isSender(frame)
  }

  onWake(): void {
    this.run(this.session.onWake(Date.now()))
  }

  onUtterance(text: string, withWake = false): void {
    this.run(this.session.onUtterance(text, Date.now(), withWake))
  }

  /** Speech-to-text failed mid-exchange. */
  onTranscribeFailed(): void {
    if (this.session.current === 'prompting' || this.session.current === 'awaitRequest') {
      this.session.onDismiss()
      this.showView({ kind: 'problem', problem: 'didntCatch' })
      this.armClose()
    }
  }

  onLevel(rms: number): void {
    this.popup.level(rms)
  }

  /** Ask events from the engine; only this exchange's own ask is used. */
  onAskEvent(e: AskEvent): void {
    if (e.askId !== this.askId || this.view.kind !== 'answer') return
    const v = this.view
    if (e.type === 'sources') this.showView({ ...v, sources: e.sources.map((s) => ({ n: s.n, fileId: s.fileId, name: s.name, location: s.location })) })
    else if (e.type === 'token') this.showView({ ...v, text: e.text })
    else if (e.type === 'done') {
      this.session.onFinished()
      if (e.insufficient || !v.text.trim()) this.showView({ kind: 'problem', heard: v.heard, problem: 'notInFiles' })
      else this.showView({ ...v, streaming: false })
      this.armClose()
    } else if (e.type === 'error') {
      this.session.onFinished()
      const problem = /answer model/i.test(e.message) ? 'needsModel' : /local AI|Ollama/i.test(e.message) ? 'needsAi' : 'answerFailed'
      this.showView({ kind: 'problem', heard: v.heard, problem })
      this.armClose()
    }
  }

  /** Voice turned off or muted: close whatever is showing. */
  close(): void {
    this.run(this.session.onDismiss())
  }

  destroy(): void {
    this.stopTimers()
    this.popup.destroy()
  }

  private run(actions: SessionAction[]): void {
    for (const a of actions) {
      switch (a.type) {
        case 'showPrompt':
          this.showCount++
          this.d.voice({ type: 'levelMeter', on: true })
          this.showView({ kind: 'prompt' })
          break
        case 'showAwaitRequest':
          this.showView({ kind: 'awaitRequest' })
          break
        case 'expectUtterance':
          this.d.voice({ type: 'expectUtterance', ms: a.ms })
          break
        case 'findFiles':
          this.d.voice({ type: 'levelMeter', on: false })
          this.lastRequest = { mode: 'search', text: a.query }
          void this.findFiles(a.query, a.folder, a.heard)
          break
        case 'ask':
          this.d.voice({ type: 'levelMeter', on: false })
          this.lastRequest = { mode: 'ask', text: a.question }
          void this.ask(a.question, a.heard)
          break
        case 'select':
          this.select(a.position === 'last' ? this.targets.length - 1 : a.position - 1)
          break
        case 'reveal':
          void this.reveal()
          break
        case 'close':
          this.hide()
          break
      }
    }
    this.ensureTicking()
  }

  private async findFiles(query: string, folder: boolean, heard: string): Promise<void> {
    this.showView({ kind: 'working', heard, mode: folder ? 'folder' : 'file', query })
    try {
      const items: PopupItem[] = []
      this.targets = []
      let indexing = false
      let weak = false
      if (folder) {
        const folders = await this.d.call<{ path: string; name: string }[]>('findFolders', { query })
        for (const f of folders) {
          items.push({ name: f.name, dir: parentOf(f.path), ext: '', isFolder: true })
          this.targets.push({ path: f.path })
        }
      }
      if (!items.length) {
        const res = await this.d.call<{ files: FileHit[]; partialIndex: boolean; lowConfidence: boolean }>('voiceSearch', { query })
        indexing = res.partialIndex
        weak = res.lowConfidence
        if (folder) {
          // No folder is named like that: offer the folders holding the best matching files instead (D-20 b).
          const seen = new Set<string>()
          for (const f of res.files) {
            const dir = parentOf(f.path)
            if (seen.has(dir)) continue
            seen.add(dir)
            items.push({ name: baseName(dir), dir: parentOf(dir), ext: '', isFolder: true })
            this.targets.push({ path: dir })
          }
        } else {
          for (const f of res.files) {
            // folderPath is the added folder; show the folder the file is actually in.
            items.push({ fileId: f.fileId, name: f.name, dir: parentOf(f.path), ext: f.ext, isFolder: false })
            this.targets.push({ path: f.path, fileId: f.fileId })
          }
        }
      }
      if (this.session.current !== 'working') return // dismissed while searching
      if (!items.length) {
        this.session.onFinished()
        this.showView({ kind: 'problem', heard, query, problem: 'noMatch' })
        this.armClose()
        return
      }
      // A weak match is never copied on its own: the user picks one first.
      if (!weak) void clipboard.writeText(this.targets[0].path)
      this.showView({ kind: 'files', heard, query, items, selected: 0, copied: !weak, weak, indexing })
      this.run(this.session.onFilesShown(Date.now()))
      this.armClose()
    } catch {
      this.session.onFinished()
      this.showView({ kind: 'problem', heard, problem: 'busy' })
      this.armClose()
    }
  }

  private async ask(question: string, heard: string): Promise<void> {
    this.askId = nextAskId++
    this.showView({ kind: 'answer', heard, text: '', streaming: true, sources: [], indexing: false })
    try {
      await this.d.call('ask', { askId: this.askId, question })
    } catch {
      this.session.onFinished()
      this.showView({ kind: 'problem', heard, problem: 'busy' })
      this.armClose()
    }
  }

  private select(index: number): void {
    if (this.view.kind !== 'files' || index < 0 || index >= this.targets.length) return
    void clipboard.writeText(this.targets[index].path)
    this.showView({ ...this.view, selected: index, copied: true })
    this.armClose()
  }

  private async reveal(): Promise<void> {
    if (this.view.kind !== 'files') return
    const t = this.targets[this.view.selected]
    if (!t) return
    if (t.fileId !== undefined) await this.d.revealFile(t.fileId)
    else await this.d.revealFolder(t.path)
  }

  handleAction(a: PopupAction): void {
    this.onPopupAction(a)
  }

  private onPopupAction(a: PopupAction): void {
    switch (a.type) {
      case 'dismiss':
        this.run(this.session.onDismiss())
        break
      case 'select':
        this.select(a.index)
        break
      case 'reveal':
        void this.reveal()
        break
      case 'openInRecall':
        if (this.lastRequest) this.d.openInRecall(this.lastRequest.mode, this.lastRequest.text)
        this.run(this.session.onDismiss())
        break
      case 'openSource':
        void this.d.openFile(a.fileId)
        break
      case 'openSettings':
        this.d.openSettings()
        this.run(this.session.onDismiss())
        break
      case 'openMicSettings':
        this.d.openMicSettings()
        break
      case 'hover':
        this.hovered = a.on
        if (a.on) clearTimeout(this.closeTimer)
        else this.armClose()
        break
      case 'speaking':
        this.setSpeaking(a.on)
        break
      case 'stopSpeech':
        this.setSpeaking(false)
        break
      case 'resize':
        this.popup.resize(a.height)
        break
    }
  }

  /** While Recall speaks, the voice process ignores the mic so it doesn't hear itself. */
  private setSpeaking(on: boolean): void {
    if (this.speaking === on) return
    this.speaking = on
    this.d.voice({ type: 'ignoreAudio', on })
    this.popup.update(this.state())
  }

  private state(): PopupState {
    return { view: this.view, speech: { enabled: this.d.readAloud(), speaking: this.speaking }, showCount: this.showCount }
  }

  private showView(view: PopupView): void {
    this.view = view
    this.popup.show(this.state())
  }

  private hide(): void {
    clearTimeout(this.closeTimer)
    this.d.voice({ type: 'levelMeter', on: false })
    this.d.voice({ type: 'expectUtterance', ms: 0 })
    this.setSpeaking(false)
    this.popup.hide()
    this.hovered = false
  }

  /** Results close on their own after a minute without the pointer over them. */
  private armClose(): void {
    clearTimeout(this.closeTimer)
    if (this.hovered) return
    this.closeTimer = setTimeout(() => this.run(this.session.onDismiss()), RESULT_CLOSE_MS)
  }

  private ensureTicking(): void {
    if (this.session.current === 'idle') {
      clearInterval(this.tickTimer)
      this.tickTimer = undefined
      return
    }
    this.tickTimer ??= setInterval(() => this.run(this.session.tick(Date.now())), 250)
  }

  private stopTimers(): void {
    clearTimeout(this.closeTimer)
    clearInterval(this.tickTimer)
    this.tickTimer = undefined
  }
}

function baseName(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p
}

function parentOf(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  parts.pop()
  return parts.join('\\')
}
