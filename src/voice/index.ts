// Voice entry: runs in its own Electron utilityProcess (ADR-0015), so a native speech crash never touches indexing.
// Commands and events go over parentPort; audio arrives on a separate MessagePort that main transfers in.
// Audio and transcripts are never written to disk or logged (plan 12 SEC-15), except by the dev-only debug
// mode in debug.ts, which packaged builds never enable.
import { installNetworkGuard } from '../engine/network-guard'
import type { VoiceCommand, VoiceEvent } from '../shared/voice'
import { withDebug } from './debug'
import { VoicePipeline } from './pipeline'
import { createSherpaModels, missingVoiceFiles } from './sherpa-models'

interface Port {
  on(event: 'message', listener: (e: { data: unknown; ports: Port[] }) => void): void
  postMessage(message: unknown): void
  start(): void
}

const parent = (process as unknown as { parentPort: Port }).parentPort
installNetworkGuard('voice')

const post = (e: VoiceEvent) => parent.postMessage(e)
const dir = process.env.RECALL_VOICE_DIR ?? ''
let pipeline: VoicePipeline | undefined

const t0 = performance.now()
const missing = missingVoiceFiles(dir)
if (missing.length) {
  console.error(`[voice] ${missing.length} model files missing`)
  post({ event: 'problem', code: 'MODELS_MISSING' })
} else {
  try {
    const models = createSherpaModels(dir)
    const debugDir = process.env.RECALL_VOICE_DEBUG
    pipeline = new VoicePipeline(debugDir ? withDebug(models, debugDir) : models, post)
    post({ event: 'ready', loadMs: Math.round(performance.now() - t0) })
  } catch (err) {
    console.error('[voice] could not load the models:', (err as Error).name)
    post({ event: 'problem', code: 'MODELS_DAMAGED' })
  }
}

parent.on('message', (e) => {
  const msg = e.data as VoiceCommand | { type: 'audioPort' }
  if (msg?.type === 'audioPort' && e.ports[0]) {
    const audio = e.ports[0]
    audio.on('message', (m) => pipeline?.frame(m.data))
    audio.start()
  } else if (msg?.type === 'shutdown') {
    process.exit(0)
  } else if (msg && typeof msg === 'object') {
    pipeline?.command(msg as VoiceCommand)
  }
})
