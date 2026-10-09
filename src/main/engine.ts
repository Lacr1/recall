import { utilityProcess, type UtilityProcess } from 'electron'
import path from 'node:path'

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void }

export class EngineError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

/** Spawns the engine utilityProcess, forwards RPC calls, and restarts it after crashes. */
export class EngineSupervisor {
  private child?: UtilityProcess
  private nextId = 1
  private pending = new Map<number, Pending>()
  private crashes: number[] = []
  private stopping = false

  constructor(
    private readonly dataDir: string,
    private readonly onEvent: (msg: unknown) => void,
    private readonly onRestart: () => void
  ) {}

  start(): void {
    this.stopping = false
    const child = utilityProcess.fork(path.join(__dirname, 'engine.js'), [], {
      serviceName: 'Recall Engine',
      stdio: 'inherit',
      env: { ...process.env, RECALL_DATA_DIR: this.dataDir }
    })
    child.on('message', (msg: { id?: number; result?: unknown; error?: { code: string; message: string }; event?: string }) => {
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new EngineError(msg.error.code, msg.error.message))
        else p.resolve(msg.result)
      } else if (msg.event) {
        this.onEvent(msg)
      }
    })
    child.on('exit', (code) => {
      for (const p of this.pending.values()) p.reject(new EngineError('ENGINE_RESTARTING', 'The indexer is restarting.'))
      this.pending.clear()
      this.child = undefined
      if (this.stopping) return
      console.error(`[main] engine exited with code ${code}`)
      const now = Date.now()
      this.crashes = this.crashes.filter((t) => now - t < 5 * 60_000).concat(now)
      if (this.crashes.length > 3) return // give up; UI shows the engine as unavailable
      setTimeout(() => {
        this.start()
        this.onRestart()
      }, 1000 * this.crashes.length)
    })
    this.child = child
  }

  call<T = unknown>(method: string, params: unknown = {}, timeoutMs = 60_000): Promise<T> {
    const child = this.child
    if (!child) return Promise.reject(new EngineError('ENGINE_UNAVAILABLE', 'The indexer is not running.'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new EngineError('ENGINE_TIMEOUT', 'The indexer did not respond.'))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v as T)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      child.postMessage({ id, method, params })
    })
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (!this.child) return
    const exited = new Promise<void>((r) => this.child?.once('exit', () => r()))
    await this.call('shutdown', {}, 5000).catch(() => this.child?.kill())
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
  }
}
