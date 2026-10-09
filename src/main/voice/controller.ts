// Owns voice in main: settings, the voice process, the renderer's mic capture, the tray and the status shown in
// the window. Each spoken exchange (popup, files, answers) is carried out by VoiceExchange.
import { app, MessageChannelMain, type BrowserWindow, type WebFrameMain } from 'electron'
import type { AskEvent } from '../../shared/types'
import { parsePopupAction } from '../../shared/popup'
import type { MicProblemCode, VoiceEvent, VoiceSettings, VoiceStatus } from '../../shared/voice'
import { VoiceExchange, type VoiceExchangeDeps } from './exchange'
import { loginItemFor, readVoiceSettings, writeVoiceSettings } from './settings'
import { VoiceSupervisor } from './supervisor'
import { RecallTray } from './tray'

export type RendererVoiceEvent =
  | { event: 'voice'; data: VoiceStatus }
  | { event: 'voiceWake' }
  | { event: 'voiceLevel'; rms: number }

export interface VoiceControllerOptions {
  dataDir: string
  voiceDir: string
  /** Smoke and end-to-end runs never touch the Windows login items. */
  isolated: boolean
  window(): BrowserWindow | undefined
  send(e: RendererVoiceEvent): void
  showWindow(): void
  quit(): void
  exchange: Omit<VoiceExchangeDeps, 'voice' | 'readAloud'>
}

export class VoiceController {
  private settings: VoiceSettings
  private ready = false
  private captureOk = false
  // A port was sent and the renderer hasn't said yet whether the mic opened: don't send another.
  private attaching = false
  private problem?: VoiceStatus['problem']
  private readonly supervisor: VoiceSupervisor
  private readonly tray: RecallTray
  private hintShown = false
  private readonly exchange: VoiceExchange

  constructor(private readonly o: VoiceControllerOptions) {
    this.settings = readVoiceSettings(o.dataDir)
    this.supervisor = new VoiceSupervisor(o.voiceDir, (e) => this.onVoiceEvent(e), () => this.onVoiceRestart())
    this.tray = new RecallTray({ open: () => o.showWindow(), setMuted: (muted) => this.update({ muted }), quit: () => o.quit() })
    this.exchange = new VoiceExchange({ ...o.exchange, voice: (cmd) => this.supervisor.send(cmd), readAloud: () => this.settings.readAloud })
  }

  /** IPC from the popup page goes only here, and only from that page. */
  popupAction(frame: WebFrameMain | null, raw: unknown): void {
    if (!this.exchange.isPopupSender(frame)) throw new Error('Untrusted sender')
    const a = parsePopupAction(raw)
    if (a) this.exchange.handleAction(a)
  }

  onAskEvent(e: AskEvent): void {
    this.exchange.onAskEvent(e)
  }

  /** End-to-end tests drive the exchange without speech: a wake word, then what was "said". */
  simulate(kind: 'wake' | 'utterance', text = ''): void {
    if (kind === 'wake') this.exchange.onWake()
    else this.exchange.onUtterance(text)
  }

  get enabled(): boolean {
    return this.settings.enabled
  }

  status(): VoiceStatus {
    const s = this.settings
    let state: VoiceStatus['state']
    if (!s.enabled) state = 'off'
    else if (this.problem) state = 'problem'
    else if (s.muted) state = 'muted'
    else if (this.ready && this.captureOk) state = 'listening'
    else state = 'starting'
    return { state, problem: s.enabled ? this.problem : undefined, settings: { ...s } }
  }

  start(): void {
    this.apply()
  }

  update(patch: Partial<VoiceSettings>): VoiceStatus {
    const wasEnabled = this.settings.enabled
    this.settings = { ...this.settings, ...patch }
    // Turning voice on again is a fresh start: clear the last problem so it can be retried.
    if (patch.enabled && !wasEnabled) this.problem = undefined
    writeVoiceSettings(this.o.dataDir, this.settings)
    this.apply()
    return this.status()
  }

  /** "Delete all data" removed the settings file: back to defaults, voice off. */
  async reset(): Promise<void> {
    this.settings = readVoiceSettings(this.o.dataDir)
    this.problem = undefined
    await this.supervisor.stop()
    this.ready = false
    this.apply()
  }

  setMeter(on: boolean): void {
    this.supervisor.send({ type: 'levelMeter', on })
  }

  /** The renderer reports whether the microphone opened. */
  captureResult(r: { ok: true } | { code: MicProblemCode }): void {
    this.attaching = false
    if ('ok' in r) {
      this.captureOk = true
      if (this.problem && this.problem.startsWith('MIC_')) this.problem = undefined
    } else {
      this.captureOk = false
      this.problem = r.code
    }
    this.publish()
  }

  /** A reload drops the renderer's end of the audio port, so a new one is attached. */
  rendererLoaded(): void {
    this.captureOk = false
    this.attaching = false
    if (this.wantsCapture()) this.attachAudio()
  }

  /** True when closing the window should hide Recall to the tray instead of quitting (D-18). */
  keepRunningOnClose(): boolean {
    if (!this.settings.enabled) return false
    if (!this.hintShown) {
      this.hintShown = true
      this.tray.notifyStillRunning()
    }
    return true
  }

  async stop(): Promise<void> {
    this.exchange.destroy()
    this.tray.destroy()
    await this.supervisor.stop()
  }

  private wantsCapture(): boolean {
    return this.settings.enabled && !this.settings.muted && this.ready
  }

  private apply(): void {
    const s = this.settings
    if (!this.o.isolated) app.setLoginItemSettings(loginItemFor(s))
    if (!s.enabled || s.muted) this.exchange.close()
    if (!s.enabled) {
      // Free the popup window too; it is created again when voice is turned back on.
      this.exchange.destroy()
      this.stopCapture()
      this.ready = false
      void this.supervisor.stop()
    } else if (!this.supervisor.running) {
      this.ready = false
      this.supervisor.start()
    } else {
      this.configure()
    }
    this.publish()
  }

  private configure(): void {
    this.supervisor.send({ type: 'setSensitivity', level: this.settings.sensitivity })
    this.supervisor.send({ type: 'setListening', on: !this.settings.muted })
    // Muted closes the microphone itself, so Windows' mic indicator goes off too.
    if (this.wantsCapture()) {
      if (!this.captureOk && !this.attaching) this.attachAudio()
    } else this.stopCapture()
  }

  private attachAudio(): void {
    const win = this.o.window()
    if (!win || win.isDestroyed()) return
    const { port1, port2 } = new MessageChannelMain()
    this.attaching = true
    this.supervisor.attachAudio(port1)
    win.webContents.postMessage('recall:audio-port', null, [port2])
  }

  private stopCapture(): void {
    this.captureOk = false
    this.attaching = false
    const win = this.o.window()
    if (win && !win.isDestroyed()) win.webContents.send('recall:audio-stop')
  }

  private onVoiceEvent(e: VoiceEvent): void {
    switch (e.event) {
      case 'ready':
        this.ready = true
        this.exchange.prepare()
        this.configure()
        this.publish()
        break
      case 'problem':
        // A failed transcription is a one-off: the exchange says "didn't catch that" and listening goes on.
        if (e.code === 'TRANSCRIBE_FAILED') {
          this.exchange.onTranscribeFailed()
          break
        }
        this.problem = e.code
        if (e.code === 'MODELS_MISSING' || e.code === 'MODELS_DAMAGED' || e.code === 'VOICE_CRASHED') this.stopCapture()
        this.publish()
        break
      case 'wake':
        this.o.send({ event: 'voiceWake' })
        this.exchange.onWake()
        break
      case 'level':
        this.o.send({ event: 'voiceLevel', rms: e.rms })
        this.exchange.onLevel(e.rms)
        break
      case 'utterance':
        // Never logged (plan 12 SEC-15).
        this.exchange.onUtterance(e.text, e.wake)
        break
    }
  }

  private onVoiceRestart(): void {
    this.ready = false
    this.captureOk = false
    this.attaching = false
    this.publish()
  }

  private publish(): void {
    const status = this.status()
    this.tray.update(status.state)
    this.o.send({ event: 'voice', data: status })
  }
}
