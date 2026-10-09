import type { OpenedIndex } from './recovery'

export interface ParentPort {
  on(event: 'message', listener: (e: { data: unknown }) => void): void
  postMessage(message: unknown): void
}

export interface EngineContext {
  port: ParentPort
  dataDir: string
  opened: OpenedIndex
}

let current: EngineContext | undefined

/** Set by the engine entry before it loads the service. */
export function setContext(ctx: EngineContext): void {
  current = ctx
}

export function context(): EngineContext {
  if (!current) throw new Error('Engine context not set')
  return current
}
