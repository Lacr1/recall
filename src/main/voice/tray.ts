import { Menu, nativeImage, Tray } from 'electron'
import type { VoiceState } from '../../shared/voice'
import { drawTrayIcon, encodePng, trayTooltip } from './tray-icon'

export interface TrayActions {
  open(): void
  setMuted(muted: boolean): void
  quit(): void
}

/** The tray icon shown while voice is on (plan 12 FR-VOICE-12). Left click opens Recall; right click shows the menu. */
export class RecallTray {
  private tray?: Tray
  private state?: VoiceState

  constructor(private readonly actions: TrayActions) {}

  /** Shows the tray for this state, or removes it when voice is off. */
  update(state: VoiceState): void {
    if (state === 'off') {
      this.tray?.destroy()
      this.tray = undefined
      this.state = undefined
      return
    }
    if (state === this.state) return
    this.state = state
    const image = nativeImage.createEmpty()
    for (const [size, scaleFactor] of [[16, 1], [24, 1.5], [32, 2]] as const) {
      image.addRepresentation({ scaleFactor, width: size, height: size, buffer: encodePng(size, drawTrayIcon(size, state)) })
    }
    if (!this.tray) {
      this.tray = new Tray(image)
      this.tray.on('click', () => this.actions.open())
    } else this.tray.setImage(image)
    this.tray.setToolTip(trayTooltip(state))
    const muted = state === 'muted'
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Recall', click: () => this.actions.open() },
        { type: 'separator' },
        { label: muted ? 'Unmute voice' : 'Mute voice', enabled: state === 'listening' || muted, click: () => this.actions.setMuted(!muted) },
        { type: 'separator' },
        { label: 'Quit Recall', click: () => this.actions.quit() }
      ])
    )
  }

  /** Shown once, the first time closing the window keeps Recall running. */
  notifyStillRunning(): void {
    this.tray?.displayBalloon({
      title: 'Recall is still listening',
      content: 'Say "Recall" any time. To quit, right-click the Recall icon here and choose Quit Recall.',
      noSound: true
    })
  }

  destroy(): void {
    this.update('off')
  }
}
