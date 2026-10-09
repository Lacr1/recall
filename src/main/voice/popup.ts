import { BrowserWindow, globalShortcut, screen, type WebFrameMain } from 'electron'
import path from 'node:path'
import { POPUP_WIDTH, type PopupAction, type PopupState } from '../../shared/popup'
import { placePopup, type Rect } from './placement'

// The card is drawn inside a transparent window with this margin on every side, so its CSS shadow shows.
const MARGIN = 12

/**
 * The voice popup near the pointer (plan 12 §5.1). Created once while voice is on and only shown and hidden
 * after that, so it appears without a load delay. Shown with showInactive(), so it never takes focus from the
 * app the user is in (S8-01, TA-14).
 */
export class VoicePopup {
  private win?: BrowserWindow
  private anchor?: { pointer: { x: number; y: number }; workArea: Rect }
  private cardHeight = 120
  private escapeHeld = false
  private last?: PopupState

  constructor(
    private readonly onAction: (a: PopupAction) => void,
    private readonly devUrl?: string
  ) {}

  /** Creates the hidden window ahead of the first wake word. */
  prepare(): void {
    if (this.win && !this.win.isDestroyed()) return
    const win = new BrowserWindow({
      width: POPUP_WIDTH + MARGIN * 2,
      height: this.cardHeight + MARGIN * 2,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      title: 'Recall',
      webPreferences: {
        preload: path.join(__dirname, '../preload/popup.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        backgroundThrottling: false
      }
    })
    win.setAlwaysOnTop(true, 'pop-up-menu')
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    win.webContents.on('will-attach-webview', (e) => e.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('did-finish-load', () => this.last && win.webContents.send('popup:state', this.last))
    win.on('closed', () => {
      this.releaseEscape()
      this.win = undefined
    })
    if (this.devUrl) void win.loadURL(this.devUrl.replace(/\/$/, '') + '/popup.html')
    else void win.loadFile(path.join(__dirname, '../renderer/popup.html'))
    this.win = win
  }

  get visible(): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.isVisible()
  }

  /** True for IPC from this popup's page, which may only use the popup channels. */
  isSender(frame: WebFrameMain | null): boolean {
    return !!frame && !!this.win && !this.win.isDestroyed() && frame === this.win.webContents.mainFrame
  }

  show(state: PopupState): void {
    this.prepare()
    const win = this.win!
    this.last = state
    win.webContents.send('popup:state', state)
    if (win.isVisible()) return
    const pointer = screen.getCursorScreenPoint()
    this.anchor = { pointer, workArea: screen.getDisplayNearestPoint(pointer).workArea }
    this.place()
    win.showInactive()
    this.holdEscape()
  }

  update(state: PopupState): void {
    this.last = state
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('popup:state', state)
  }

  /** Mic level while listening, for the meter in the status pill. */
  level(rms: number): void {
    if (this.visible) this.win!.webContents.send('popup:level', rms)
  }

  /** The page measured its card; resize around the same pointer position. */
  resize(height: number): void {
    this.cardHeight = height
    if (this.visible) this.place()
  }

  hide(): void {
    this.releaseEscape()
    if (this.win && !this.win.isDestroyed()) this.win.hide()
  }

  destroy(): void {
    this.releaseEscape()
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = undefined
  }

  private place(): void {
    if (!this.win || !this.anchor) return
    const size = { width: POPUP_WIDTH + MARGIN * 2, height: this.cardHeight + MARGIN * 2 }
    // The card, not the transparent margin, keeps its distance from the pointer.
    const pos = placePopup(this.anchor.pointer, { width: size.width - MARGIN * 2, height: size.height - MARGIN * 2 }, this.anchor.workArea)
    this.win.setBounds({ x: pos.x - MARGIN, y: pos.y - MARGIN, ...size })
  }

  /** Esc closes the popup even while another app has focus, only while it is showing (D-22). */
  private holdEscape(): void {
    if (this.escapeHeld) return
    this.escapeHeld = globalShortcut.register('Escape', () => this.onAction({ type: 'dismiss' }))
  }

  private releaseEscape(): void {
    if (!this.escapeHeld) return
    globalShortcut.unregister('Escape')
    this.escapeHeld = false
  }
}
