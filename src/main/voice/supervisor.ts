import { app, utilityProcess, type MessagePortMain, type UtilityProcess } from 'electron'
import path from 'node:path'
import type { VoiceCommand, VoiceEvent } from '../../shared/voice'

/**
 * Spawns the voice utilityProcess (ADR-0015), passes commands and audio ports to it, and restarts it after
 * crashes. After more than 3 crashes in 5 minutes it gives up and reports VOICE_CRASHED, like the engine.
 */
export class VoiceSupervisor {
  private child?: UtilityProcess
  private crashes: number[] = []
  private stopping = false

  constructor(
    private readonly voiceDir: string,
    private readonly onEvent: (e: VoiceEvent) => void,
    /** The audio port dies with the process, so the owner must attach a new one after a restart. */
    private readonly onRestart: () => void = () => undefined
  ) {}

  get running(): boolean {
    return !!this.child
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  start(): void {
    if (this.child) return
    this.stopping = false
    const env: NodeJS.ProcessEnv = { ...process.env, RECALL_VOICE_DIR: this.voiceDir }
    // The debug mode records the microphone, so a shipped Recall never passes it on.
    if (app.isPackaged) delete env.RECALL_VOICE_DEBUG
    const child = utilityProcess.fork(path.join(__dirname, 'voice.js'), [], { serviceName: 'Recall Voice', stdio: 'inherit', env })
    child.on('message', (e: VoiceEvent) => this.onEvent(e))
    child.on('exit', (code) => {
      this.child = undefined
      if (this.stopping) return
      console.error(`[main] voice process exited with code ${code}`)
      const now = Date.now()
      this.crashes = this.crashes.filter((t) => now - t < 5 * 60_000).concat(now)
      if (this.crashes.length > 3) {
        this.onEvent({ event: 'problem', code: 'VOICE_CRASHED' })
        return
      }
      setTimeout(() => {
        this.start()
        this.onRestart()
      }, 1000 * this.crashes.length)
    })
    this.child = child
  }

  send(cmd: VoiceCommand): void {
    this.child?.postMessage(cmd)
  }

  /** Audio frames travel on this port straight to the voice process, never through IPC handlers. */
  attachAudio(port: MessagePortMain): void {
    this.child?.postMessage({ type: 'audioPort' }, [port])
  }

  async stop(): Promise<void> {
    this.stopping = true
    const child = this.child
    if (!child) return
    const exited = new Promise<void>((r) => child.once('exit', () => r()))
    child.postMessage({ type: 'shutdown' })
    const timeout = setTimeout(() => child.kill(), 3000)
    await exited
    clearTimeout(timeout)
  }
}
