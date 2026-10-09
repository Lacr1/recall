import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, session, shell, type IpcMainInvokeEvent } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, realpath, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { EngineError, EngineSupervisor } from './engine'
import { runSmokeTest } from './smoke'
import { installNetworkGuard } from '../engine/network-guard'
import { removeIndexFiles } from '../engine/index-files'
import { isInsideRoot, isSafeLocalPath, isSafeToOpen } from '../engine/paths'
import { RENDERER_METHODS } from '../shared/constants'
import type { FolderSuggestion, SuggestedFolderId } from '../shared/types'

// Main never needs the network itself; the renderer's requests are filtered separately in hardenSession().
installNetworkGuard('main')
// No proxy: Recall loads only local files. Without this, Chromium's proxy auto-detection (WPAD) sends DNS
// queries for "wpad" to the local network whenever Windows has "Automatically detect settings" on.
app.commandLine.appendSwitch('no-proxy-server')

// Index data lives in LocalAppData, not Roaming, so roaming profiles never sync it (plan doc 05 §2).
const DATA_DIR = process.env.RECALL_DATA_DIR || path.join(process.env.LOCALAPPDATA ?? app.getPath('userData'), 'Recall', 'data')
const OLLAMA_APP = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Ollama', 'ollama app.exe')
const DEV_URL = process.env.ELECTRON_RENDERER_URL

const SMOKE_FOLDER = process.argv.find((a) => a.startsWith('--smoke-test='))?.slice('--smoke-test='.length)

// Smoke and end-to-end runs use their own Electron profile so they work while a normal Recall window is open.
// It sits beside the data folder, not inside it, so "Delete all data" never removes a profile that is in use.
const ISOLATED_RUN = !!SMOKE_FOLDER || process.env.RECALL_E2E === '1'

const SUGGESTED_FOLDERS: Record<SuggestedFolderId, string> = { documents: 'Documents', desktop: 'Desktop', downloads: 'Downloads' }

let win: BrowserWindow | undefined

if (ISOLATED_RUN) app.setPath('userData', DATA_DIR + '-profile')

if (!ISOLATED_RUN && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  app.whenReady().then(main)
}

const engine = new EngineSupervisor(
  DATA_DIR,
  (msg) => win?.webContents.send('recall:event', msg),
  () => win?.webContents.send('recall:event', { event: 'engineRestarted' }),
  () => win?.webContents.send('recall:event', { event: 'engineStopped' })
)

function main(): void {
  hardenSession()
  engine.start()
  registerIpc()
  createWindow()
  if (SMOKE_FOLDER) {
    void runSmokeTest(SMOKE_FOLDER, engine, win).then(async (code) => {
      await engine.stop()
      app.exit(code)
    })
    return
  }
  app.on('window-all-closed', async () => {
    await engine.stop()
    app.quit()
  })
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Recall',
    // Matches --bg so the splash appears without a light flash in dark mode.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#151617' : '#f7f7f5',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.on('will-attach-webview', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('render-process-gone', () => win?.reload())
  if (DEV_URL) void win.loadURL(DEV_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

/** Renderer gets no network and no permissions (plan doc 06 §5). */
function hardenSession(): void {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
  ses.webRequest.onBeforeRequest((details, cb) => {
    const url = new URL(details.url)
    const devLocal = !!DEV_URL && ['localhost', '127.0.0.1'].includes(url.hostname)
    const allowed = url.protocol === 'file:' || url.protocol === 'devtools:' || url.protocol === 'data:' || devLocal
    cb({ cancel: !allowed })
  })
}

function isTrustedSender(e: IpcMainInvokeEvent): boolean {
  const frame = e.senderFrame
  if (!frame || frame !== win?.webContents.mainFrame) return false
  const url = frame.url
  return url.startsWith('file://') || (!!DEV_URL && url.startsWith(DEV_URL))
}

type Fail = { ok: false; code: string; message: string }
const fail = (code: string, message: string): Fail => ({ ok: false, code, message })

function handle(channel: string, fn: (params: Record<string, unknown>) => unknown): void {
  ipcMain.handle(`recall:${channel}`, async (e, params) => {
    if (!isTrustedSender(e)) throw new Error('Untrusted sender')
    const p = params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {}
    try {
      return await fn(p)
    } catch (err) {
      if (err instanceof EngineError) throw new Error(`${err.code}: ${err.message}`)
      throw err
    }
  })
}

const int = (v: unknown) => {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) throw new Error('Invalid id')
  return n
}

function registerIpc(): void {
  // Engine-backed calls the renderer may make, with per-method parameter validation.
  const validators: Record<(typeof RENDERER_METHODS)[number], (p: Record<string, unknown>) => unknown> = {
    getStatus: () => ({}),
    search: (p) => ({ requestId: int(p.requestId), query: String(p.query ?? '').slice(0, 500) }),
    getDocument: (p) => ({ fileId: int(p.fileId) }),
    listFailures: () => ({}),
    removeFolder: (p) => ({ folderId: int(p.folderId) }),
    rescanFolder: (p) => ({ folderId: int(p.folderId) }),
    retryFailed: () => ({}),
    setPaused: (p) => ({ paused: p.paused === true }),
    pullModel: () => ({}),
    ask: (p) => ({ askId: int(p.askId), question: String(p.question ?? '').slice(0, 1000) }),
    cancelAsk: (p) => ({ askId: int(p.askId) }),
    deleteAllData: () => ({})
  }
  for (const method of RENDERER_METHODS) {
    if (method === 'deleteAllData') continue
    handle(method, (p) => engine.call(method, validators[method](p)))
  }

  handle('deleteAllData', async () => {
    await engine.stop()
    await rm(DATA_DIR, { recursive: true, force: true })
    await session.defaultSession.clearStorageData()
    engine.start()
    // Reloaded from here: a renderer-initiated reload is cancelled by the will-navigate block.
    setImmediate(() => win?.webContents.reload())
  })

  // The index is derived data: rebuilding deletes it but keeps the folder list, so the new index re-reads the same folders.
  handle('rebuildIndex', async () => {
    await engine.stop()
    removeIndexFiles(DATA_DIR)
    engine.start()
    setImmediate(() => win?.webContents.reload())
  })

  handle('restartEngine', () => {
    engine.restart()
    setImmediate(() => win?.webContents.reload())
  })

  handle('getDataInfo', async () => ({ path: DATA_DIR, bytes: await dirSize(DATA_DIR) }))

  const addFolderPath = async (folderPath: string) => {
    try {
      return { folder: await engine.call('addFolder', { path: folderPath }) }
    } catch (err) {
      return { error: err instanceof EngineError ? err.message : 'Could not add this folder.' }
    }
  }

  // Folder paths come from the native dialog or Windows' known folders in main, never from the renderer.
  handle('addFolder', async () => {
    const res = await dialog.showOpenDialog(win!, { title: 'Choose a folder for Recall to remember', properties: ['openDirectory'] })
    if (res.canceled || !res.filePaths[0]) return { cancelled: true }
    return addFolderPath(res.filePaths[0])
  })

  handle('getFolderSuggestions', async () => {
    const out: FolderSuggestion[] = []
    for (const [id, label] of Object.entries(SUGGESTED_FOLDERS) as [SuggestedFolderId, string][]) {
      const folderPath = app.getPath(id)
      if (await isDirectory(folderPath)) out.push({ id, label, path: folderPath })
    }
    return out
  })

  handle('addSuggestedFolder', (p) => {
    const id = String(p.id)
    if (!Object.hasOwn(SUGGESTED_FOLDERS, id)) throw new Error('Invalid folder')
    return addFolderPath(app.getPath(id as SuggestedFolderId))
  })

  handle('openFile', async (p) => {
    const checked = await resolveChecked(int(p.fileId))
    if (!checked.ok) return checked
    if (!isSafeToOpen(path.extname(checked.real).slice(1))) {
      return fail('NOT_OPENABLE', 'Recall does not launch this type of file because Windows may run it. Use "Show in folder" instead.')
    }
    const err = await shell.openPath(checked.real)
    return err ? fail('OPEN_FAILED', err) : { ok: true }
  })

  handle('revealFile', async (p) => {
    const checked = await resolveChecked(int(p.fileId))
    if (!checked.ok) return checked
    shell.showItemInFolder(checked.real)
    return { ok: true }
  })

  handle('copyPath', async (p) => {
    const row = await engine.call<{ path: string } | null>('resolveFile', { fileId: int(p.fileId) })
    if (!row) return fail('FILE_UNKNOWN', 'This file is no longer in the index.')
    clipboard.writeText(row.path)
    return { ok: true }
  })

  handle('startOllama', async () => {
    if (!existsSync(OLLAMA_APP)) return fail('NOT_INSTALLED', 'Ollama is not installed.')
    spawn(OLLAMA_APP, [], { detached: true, stdio: 'ignore' }).unref()
    setTimeout(() => void engine.call('recheckAi').catch(() => undefined), 3000)
    return { ok: true }
  })

  // The only external link Recall opens, to a fixed URL.
  handle('openOllamaDownload', () => shell.openExternal('https://ollama.com/download/windows'))
}

/** Open-file guard (plan doc 06 §5.1): resolve by id, re-validate the real path on disk. */
async function resolveChecked(fileId: number): Promise<{ ok: true; real: string } | Fail> {
  const row = await engine.call<{ path: string; root: string } | null>('resolveFile', { fileId })
  if (!row) return fail('FILE_UNKNOWN', 'This file is no longer in the index.')
  if (!isSafeLocalPath(row.path)) return fail('PATH_REJECTED', 'This path cannot be opened.')
  let real: string
  try {
    real = await realpath(row.path)
  } catch {
    void engine.call('rescanPath', { path: row.path }).catch(() => undefined)
    return fail('FILE_MISSING', 'This file was moved or deleted since Recall last checked. Recall is re-checking the folder.')
  }
  if (!isInsideRoot(real, row.root)) return fail('PATH_REJECTED', 'This file is outside the folders you added.')
  return { ok: true, real }
}

async function dirSize(dir: string): Promise<number> {
  let total = 0
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      total += entry.isDirectory() ? await dirSize(p) : (await stat(p)).size
    }
  } catch {
    // Missing directory counts as zero.
  }
  return total
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}
