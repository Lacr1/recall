// The engine proper: owns the database, indexing and search. Loaded by index.ts once the index has opened.
// It talks only to the main process, over process.parentPort.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { context } from './context'
import { assertIndexConsistent, getSetting } from './db'
import { Indexer, UserError } from './indexer'
import { embed, getVersion, hasModel, listModels, OllamaError, pullModel } from './ollama'
import { SearchService } from './search'
import { searchSuggestions } from './suggestions'
import { toUnitVec, VectorIndex } from './vectors'
import { runAsk } from './ask'
import { readDocument } from './documents'
import { isSafeLocalPath, pathKey } from './paths'
import { markCheckNextStart, markCleanShutdown, readFolderList, writeFolderList } from './index-files'
import { isCorruption } from './recovery'
import { CHAT_MODEL, EMBED_MODEL, QUERY_PREFIX } from '../shared/constants'
import type { AiStatus, AppStatus, SearchResponse } from '../shared/types'

const { port, dataDir, opened } = context()
const db = opened.db
const vectors = new VectorIndex(db)
const searchService = new SearchService(db, vectors)

let ai: AiStatus = { state: 'checking', embedModel: EMBED_MODEL, chatModel: CHAT_MODEL, chatAvailable: false }

let statusTimer: NodeJS.Timeout | undefined
function scheduleStatus(): void {
  if (statusTimer) return
  statusTimer = setTimeout(() => {
    statusTimer = undefined
    port.postMessage({ event: 'status', data: getStatus() })
  }, 400)
}

const indexer = new Indexer(
  db,
  vectors,
  scheduleStatus,
  (err) => {
    if (err.code === 'unreachable' || err.code === 'timeout') void probeAi()
    if (err.code === 'model_missing') void probeAi()
  },
  onDatabaseError
)

/**
 * SQLite found a damaged page while running. Stop at once; main restarts the engine, which then checks the index
 * and, if it is damaged, offers a rebuild instead of carrying on with bad data.
 */
function onDatabaseError(err: unknown): void {
  if (!isCorruption(err)) return
  console.error('[engine] database damaged:', (err as { code?: string }).code)
  markCheckNextStart(dataDir)
  process.exit(1)
}

// A new, empty index next to a saved folder list means the index was rebuilt: re-add the same folders.
let rebuilt = false
if (opened.fresh) {
  const saved = readFolderList(dataDir)
  for (const folder of saved?.folders ?? []) {
    try {
      indexer.addFolder(folder)
      rebuilt = true
    } catch (err) {
      console.error('[engine] could not restore a folder:', (err as { code?: string }).code ?? (err as Error).name)
    }
  }
  if (saved?.paused) indexer.setPaused(true)
}

/** Keeps the folder list outside the database, so a rebuild knows which folders to read again. */
function saveFolderList(): void {
  try {
    writeFolderList(dataDir, { folders: indexer.listFolders().map((f) => f.path), paused: getSetting(db, 'paused') === '1' })
  } catch (err) {
    console.error('[engine] could not save the folder list:', (err as { code?: string }).code ?? (err as Error).name)
  }
}
saveFolderList()

function getStatus(): AppStatus {
  return { ai, progress: indexer.progress(), folders: indexer.listFolders(), rebuilt: rebuilt || undefined }
}

// ---------- local AI readiness ----------

const OLLAMA_INSTALL = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Ollama', 'ollama app.exe')
let probeTimer: NodeJS.Timeout | undefined

async function probeAi(): Promise<void> {
  clearTimeout(probeTimer)
  if (ai.state !== 'pulling') {
    let next: AiStatus
    try {
      const version = await getVersion()
      const models = await listModels()
      const ready = hasModel(models, EMBED_MODEL)
      next = { ...ai, state: ready ? 'ready' : 'model_missing', ollamaVersion: version, chatAvailable: hasModel(models, CHAT_MODEL), error: undefined, pull: undefined }
    } catch {
      next = { ...ai, state: existsSync(OLLAMA_INSTALL) ? 'not_running' : 'not_installed', chatAvailable: false }
    }
    const changed = next.state !== ai.state || next.chatAvailable !== ai.chatAvailable
    ai = next
    indexer.setAiReady(ai.state === 'ready')
    if (changed) scheduleStatus()
  }
  probeTimer = setTimeout(probeAi, ai.state === 'ready' ? 15_000 : 3_000)
}

async function startPull(): Promise<void> {
  if (ai.state === 'pulling') return
  ai = { ...ai, state: 'pulling', pull: { status: 'starting', completed: 0, total: 0 }, error: undefined }
  scheduleStatus()
  try {
    await pullModel(EMBED_MODEL, (p) => {
      ai = { ...ai, pull: p }
      scheduleStatus()
    })
    ai = { ...ai, state: 'checking', pull: undefined }
  } catch (err) {
    ai = { ...ai, state: 'checking', pull: undefined, error: 'Download failed: ' + (err as Error).message }
  }
  await probeAi()
}

// ---------- search & ask ----------

const queryCache = new Map<string, Float32Array>()

async function embedQuery(q: string): Promise<Float32Array | undefined> {
  if (ai.state !== 'ready') return undefined
  const key = q.trim().toLowerCase()
  const hit = queryCache.get(key)
  if (hit) return hit
  try {
    const [v] = await embed(EMBED_MODEL, [QUERY_PREFIX + q], { timeoutMs: 15_000 })
    const unit = toUnitVec(v)
    queryCache.set(key, unit)
    if (queryCache.size > 100) queryCache.delete(queryCache.keys().next().value!)
    return unit
  } catch (err) {
    if (err instanceof OllamaError) void probeAi()
    return undefined
  }
}

let latestSearch = 0

async function search(params: { requestId: number; query: string }): Promise<SearchResponse | null> {
  const t0 = performance.now()
  latestSearch = params.requestId
  const q = String(params.query ?? '').slice(0, 500)
  const vec = await embedQuery(q)
  if (params.requestId !== latestSearch) return null // superseded while embedding
  const { results, lowConfidence } = searchService.search(q, vec)
  const p = indexer.progress()
  return {
    requestId: params.requestId,
    query: q,
    mode: vec ? 'hybrid' : 'keyword',
    modeReason: vec ? undefined : ai.state === 'ready' ? 'Local AI did not respond' : 'Local AI is not set up',
    tookMs: Math.round(performance.now() - t0),
    results,
    lowConfidence,
    partialIndex: p.filesPending > 0 || p.readDone < p.readTotal || p.embedDone < p.embedTotal || p.scanning
  }
}

// Rebuilt only when more files have been read or the folder list changed.
let suggestionCache: { key: string; queries: string[] } | undefined

function getSearchSuggestions(): string[] {
  const p = indexer.progress()
  const key = `${p.readDone}:${p.filesTotal}`
  if (suggestionCache?.key !== key) suggestionCache = { key, queries: searchSuggestions(db).map((s) => s.query) }
  return suggestionCache.queries
}

const asks = new Map<number, AbortController>()

async function ask(params: { askId: number; question: string }): Promise<void> {
  const emit = (data: unknown) => port.postMessage({ event: 'ask', data })
  const vec = await embedQuery(params.question)
  if (!vec) {
    emit({ type: 'error', askId: params.askId, message: 'Ask needs local AI. Make sure Ollama is running.' })
    return
  }
  if (!ai.chatAvailable) {
    emit({ type: 'error', askId: params.askId, message: `The answer model (${CHAT_MODEL}) is not installed in Ollama.` })
    return
  }
  const ctrl = new AbortController()
  asks.set(params.askId, ctrl)
  try {
    await runAsk(db, searchService, params.askId, String(params.question).slice(0, 1000), vec, ctrl.signal, emit)
  } catch (err) {
    if (!ctrl.signal.aborted) emit({ type: 'error', askId: params.askId, message: 'The local model failed to answer: ' + (err as Error).message })
    else emit({ type: 'done', askId: params.askId, insufficient: false, invalidCitations: [] })
  } finally {
    asks.delete(params.askId)
  }
}

// ---------- RPC ----------

type Handler = (params: any) => unknown // eslint-disable-line @typescript-eslint/no-explicit-any -- params are validated per method

const handlers: Record<string, Handler> = {
  getStatus,
  search,
  getSearchSuggestions,
  ask: (p) => {
    void ask(p)
    return true
  },
  cancelAsk: (p: { askId: number }) => {
    asks.get(p.askId)?.abort()
    return true
  },
  getDocument: (p: { fileId: number }) => readDocument(db, Number(p.fileId)),
  listFailures: () => indexer.listFailures(),
  addFolder: (p: { path: string }) => {
    if (!isSafeLocalPath(p.path)) throw new UserError('FOLDER_INVALID', 'Only local folders can be added.')
    const folder = indexer.addFolder(p.path)
    saveFolderList()
    return folder
  },
  removeFolder: (p: { folderId: number }) => {
    indexer.removeFolder(Number(p.folderId))
    saveFolderList()
  },
  rescanFolder: (p: { folderId: number }) => indexer.rescanFolder(Number(p.folderId)),
  retryFailed: () => indexer.retryFailed(),
  setPaused: (p: { paused: boolean }) => {
    indexer.setPaused(!!p.paused)
    saveFolderList()
  },
  pullModel: () => {
    void startPull()
    return true
  },
  recheckAi: () => probeAi(),
  // Main-only: resolve a file id to its path and folder root for the open-file guard.
  resolveFile: (p: { fileId: number }) =>
    db
      .prepare(`SELECT f.path || '\\' || x.rel_path path, f.path root, x.ext FROM files x JOIN folders f ON f.id = x.folder_id WHERE x.id = ?`)
      .get(Number(p.fileId)) ?? null,
  rescanPath: (p: { path: string }) => {
    const row = db.prepare('SELECT id, path_key FROM folders').all() as { id: number; path_key: string }[]
    const key = pathKey(p.path)
    for (const f of row) if (key.startsWith(f.path_key + '\\')) indexer.rescanFolder(f.id)
    return true
  },
  checkConsistency: () => {
    assertIndexConsistent(db)
    return true
  },
  shutdown: () => {
    indexer.stop()
    db.close()
    markCleanShutdown(dataDir)
    setImmediate(() => process.exit(0))
    return true
  }
}

port.on('message', async (e) => {
  const msg = e.data as { id: number; method: string; params: unknown }
  const handler = handlers[msg.method]
  try {
    if (!handler) throw new UserError('UNKNOWN_METHOD', `Unknown method ${msg.method}`)
    const result = await handler(msg.params ?? {})
    port.postMessage({ id: msg.id, result: result ?? null })
  } catch (err) {
    onDatabaseError(err)
    const code = (err as { code?: string }).code ?? 'ENGINE_ERROR'
    const message = err instanceof UserError ? err.message : 'Something went wrong in the indexer.'
    if (!(err instanceof UserError)) console.error('[engine] handler error', msg.method, (err as Error).name, code)
    port.postMessage({ id: msg.id, error: { code, message } })
  }
})

indexer.start()
// Load the vector cache now so the first search after launch is not slowed by it.
setTimeout(() => vectors.size, 500)
void probeAi()
scheduleStatus()
