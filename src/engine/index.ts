// Engine entry: runs in an Electron utilityProcess. It opens the index and then loads the engine proper
// (service.ts). If the index can't be used, it stays up in "problem mode" so the window can explain what happened
// and offer a rebuild, instead of crash-looping (plan S3-04, doc 02 §5.13).
import { mkdirSync } from 'node:fs'
import { setContext, type ParentPort } from './context'
import { installNetworkGuard } from './network-guard'
import { IndexProblem, openIndex } from './recovery'
import { CHAT_MODEL, EMBED_MODEL } from '../shared/constants'
import type { AppStatus } from '../shared/types'

const port = (process as unknown as { parentPort: ParentPort }).parentPort
installNetworkGuard('engine')

const dataDir = process.env.RECALL_DATA_DIR!
let problem: IndexProblem | undefined
try {
  mkdirSync(dataDir, { recursive: true })
  const opened = openIndex(dataDir)
  if (opened.checkMs !== undefined) console.log(`[engine] index check after unclean shutdown: ok in ${opened.checkMs} ms`)
  setContext({ port, dataDir, opened })
} catch (err) {
  problem = err instanceof IndexProblem ? err : new IndexProblem('cannot_open', `Recall can't open its index: ${(err as Error).message}`)
  console.error(`[engine] index problem: ${problem.code}`)
}

if (problem) serveProblem(problem)
else void import('./service')

/** Answers status with the problem and refuses everything else; main handles the rebuild. */
function serveProblem(p: IndexProblem): void {
  const status: AppStatus = {
    ai: { state: 'checking', embedModel: EMBED_MODEL, chatModel: CHAT_MODEL, chatAvailable: false },
    progress: { paused: false, scanning: false, filesTotal: 0, filesPending: 0, readDone: 0, readTotal: 0, embedDone: 0, embedTotal: 0, skipped: 0, failed: 0, chunks: 0 },
    folders: [],
    problem: { code: p.code, message: p.message }
  }
  port.on('message', (e) => {
    const msg = e.data as { id: number; method: string }
    if (msg.method === 'getStatus') port.postMessage({ id: msg.id, result: status })
    else if (msg.method === 'shutdown') {
      port.postMessage({ id: msg.id, result: true })
      setImmediate(() => process.exit(0))
    } else port.postMessage({ id: msg.id, error: { code: 'INDEX_PROBLEM', message: 'Recall needs to rebuild its index first.' } })
  })
  port.postMessage({ event: 'status', data: status })
}
