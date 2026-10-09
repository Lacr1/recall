import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, screen, session, shell, type IpcMainInvokeEvent } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { readdir, realpath, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { EngineError, EngineSupervisor } from './engine'
import { runSmokeTest } from './smoke'
import { allowPermissionCheck, allowPermissionRequest } from './permissions'
import { VoiceController } from './voice/controller'
import { voiceSettingsPatch } from './voice/settings'
import { APP_MIN_SIZE, applyWindowMode, fitSize, parseWindowAction, parseWindowMode, startsInOnboarding, WINDOW_SIZE, type WindowMode } from './window-frame'
import { runVoiceSmoke } from './voice/smoke'
import { installNetworkGuard } from '../engine/network-guard'
import { removeIndexFiles } from '../engine/index-files'
import { isInsideRoot, isSafeLocalPath, isSafeToOpen } from '../engine/paths'
import { RENDERER_METHODS } from '../shared/constants'
import type { AskEvent, FolderSuggestion, SuggestedFolderId } from '../shared/types'
import { MIC_PROBLEM_CODES, type MicProblemCode } from '../shared/voice'
import appIcon from '../../build/icon.png?asset'

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
const VOICE_SMOKE = process.argv.find((a) => a.startsWith('--voice-smoke='))?.slice('--voice-smoke='.length)
// Bundled voice models (plan 12 D-17): resources/voice in dev, <install>/resources/voice when packaged.
const VOICE_DIR = app.isPackaged ? path.join(process.resourcesPath, 'voice') : path.join(app.getAppPath(), 'resources', 'voice')

// Smoke and end-to-end runs use their own Electron profile so they work while a normal Recall window is open.
// It sits beside the data folder, not inside it, so "Delete all data" never removes a profile that is in use.
const ISOLATED_RUN = !!SMOKE_FOLDER || !!VOICE_SMOKE || process.env.RECALL_E2E === '1'
// Started by Windows at login (FR-VOICE-14): stay in the tray until the user opens Recall.
const START_HIDDEN = process.argv.includes('--hidden')

// End-to-end tests only: Chromium plays this WAV as the microphone.
if (process.env.RECALL_E2E === '1' && process.env.RECALL_FAKE_MIC) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.RECALL_FAKE_MIC)
}

const SUGGESTED_FOLDERS: Record<SuggestedFolderId, string> = { documents: 'Documents', desktop: 'Desktop', downloads: 'Downloads' }

let win: BrowserWindow | undefined
let windowMode: WindowMode = 'app'
// Set when the user really quits (tray menu), so closing the window no longer just hides it.
let quitting = false

if (ISOLATED_RUN) app.setPath('userData', DATA_DIR + '-profile')

if (!ISOLATED_RUN && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.whenReady().then(main)
}

function showWindow(): void {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function quitApp(): void {
  quitting = true
  if (win && !win.isDestroyed()) win.close()
  else app.quit()
}

const voice = new VoiceController({
  dataDir: DATA_DIR,
  voiceDir: VOICE_DIR,
  isolated: ISOLATED_RUN,
  window: () => win,
  send: (e) => win?.webContents.send('recall:event', e),
  showWindow,
  quit: quitApp,
  exchange: {
    call: (method, params) => engine.call(method, params),
    revealFile: async (fileId) => {
      const checked = await resolveChecked(fileId)
      if (checked.ok) shell.showItemInFolder(checked.real)
    },
    revealFolder: async (folderPath) => {
      const real = await checkedFolder(folderPath)
      if (real) await shell.openPath(real)
    },
    openFile: async (fileId) => void (await openIndexedFile(fileId)),
    openInRecall: (view, text) => {
      showWindow()
      win?.webContents.send('recall:event', { event: 'voiceOpen', view, text })
    },
    openSettings: () => {
      showWindow()
      win?.webContents.send('recall:event', { event: 'voiceOpen', view: 'settings', text: '' })
    },
    openMicSettings: () => void shell.openExternal('ms-settings:privacy-microphone'),
    devUrl: DEV_URL
  }
})

// End-to-end tests only: drive a spoken exchange without speech.
if (process.env.RECALL_E2E === '1') {
  ;(globalThis as unknown as { __recallVoice: unknown }).__recallVoice = {
    wake: () => voice.simulate('wake'),
    say: (text: string) => voice.simulate('utterance', text)
  }
}

const engine = new EngineSupervisor(
  DATA_DIR,
  (msg) => {
    const m = msg as { event?: string; data?: unknown }
    if (m.event === 'ask') voice.onAskEvent(m.data as AskEvent)
    win?.webContents.send('recall:event', msg)
  },
  () => win?.webContents.send('recall:event', { event: 'engineRestarted' }),
  () => win?.webContents.send('recall:event', { event: 'engineStopped' })
)

function main(): void {
  hardenSession()
  if (VOICE_SMOKE) {
    void runVoiceSmoke(VOICE_SMOKE, VOICE_DIR).then((code) => app.exit(code))
    return
  }
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
  voice.start()
  app.on('window-all-closed', () => void shutdown())
}

let shuttingDown = false
/** Stops the engine and voice, then quits. Runs once. */
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  await Promise.all([engine.stop(), voice.stop()])
  app.quit()
}

function createWindow(): void {
  let foldersJson: string | undefined
  try {
    foldersJson = readFileSync(path.join(DATA_DIR, 'folders.json'), 'utf8')
  } catch {
    // No folder list yet: first run.
  }
  windowMode = startsInOnboarding(foldersJson) ? 'onboarding' : 'app'
  const onboarding = windowMode === 'onboarding'
  const size = fitSize(WINDOW_SIZE[windowMode], screen.getPrimaryDisplay().workArea)
  win = new BrowserWindow({
    ...size,
    minWidth: onboarding ? size.width : APP_MIN_SIZE.width,
    minHeight: onboarding ? size.height : APP_MIN_SIZE.height,
    resizable: !onboarding,
    maximizable: !onboarding,
    // Recall draws its own title bar (TitleBar); Windows keeps the shadow, resize edges and snapping.
    frame: false,
    show: false,
    title: 'Recall',
    icon: appIcon,
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
  win.once('ready-to-show', () => {
    if (!(START_HIDDEN && voice.enabled)) win?.show()
  })
  // While voice is on, closing hides Recall to the tray so it keeps listening (plan 12 D-18).
  win.on('close', (e) => {
    if (!quitting && voice.keepRunningOnClose()) {
      e.preventDefault()
      win?.hide()
    }
  })
  win.webContents.on('did-finish-load', () => voice.rendererLoaded())
  // The title bar shows Maximize or Restore.
  win.on('maximize', () => win?.webContents.send('recall:event', { event: 'window', maximized: true }))
  win.on('unmaximize', () => win?.webContents.send('recall:event', { event: 'window', maximized: false }))
  // The main window only really closes when Recall quits (otherwise it hides), and the voice popup must not keep
  // the app alive behind it.
  win.on('closed', () => {
    win = undefined
    if (!SMOKE_FOLDER) void shutdown()
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.on('will-attach-webview', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('render-process-gone', () => win?.reload())
  if (DEV_URL) void win.loadURL(DEV_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

/** Renderer gets no network and no permissions except microphone audio for voice (plan doc 06 §5, plan 12 SEC-13). */
function hardenSession(): void {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined
    cb(allowPermissionRequest({ permission, fromMainWindow: wc === win?.webContents, url: details.requestingUrl, mediaTypes, devUrl: DEV_URL }))
  })
  ses.setPermissionCheckHandler((wc, permission, origin, details) =>
    allowPermissionCheck({ permission, fromMainWindow: !!wc && wc === win?.webContents, mediaType: details.mediaType, url: origin, devUrl: DEV_URL })
  )
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
    getSearchSuggestions: () => ({}),
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
    // The voice settings file was in the data folder: voice turns off and the login item is removed.
    await voice.reset()
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

  // The popup's channel: accepted only from the popup's own page, and every action is validated.
  ipcMain.handle('popup:action', (e, a) => voice.popupAction(e.senderFrame, a))

  handle('getVoiceStatus', () => voice.status())
  handle('setVoiceSettings', (p) => voice.update(voiceSettingsPatch(p)))
  handle('setVoiceMeter', (p) => voice.setMeter(p.on === true))
  handle('voiceCapture', (p) => {
    if (p.ok === true) voice.captureResult({ ok: true })
    else if (MIC_PROBLEM_CODES.includes(p.code as MicProblemCode)) voice.captureResult({ code: p.code as MicProblemCode })
  })
  // Fixed Windows settings page; nothing from the renderer is passed through.
  handle('openMicSettings', () => shell.openExternal('ms-settings:privacy-microphone'))

  handle('getDataInfo', async () => ({ path: DATA_DIR, bytes: await dirSize(DATA_DIR) }))

  // The custom title bar (the window has no Windows frame).
  handle('setWindowMode', (p) => {
    const mode = parseWindowMode(p.mode)
    if (!mode || !win || mode === windowMode) return
    windowMode = mode
    applyWindowMode(win, mode)
  })
  handle('windowControl', (p) => {
    const action = parseWindowAction(p.action)
    if (!win || !action) return
    if (action === 'minimize') win.minimize()
    else if (action === 'close') win.close()
    else if (win.isMaximizable()) {
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    }
  })

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

  handle('openFile', (p) => openIndexedFile(int(p.fileId)))

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

async function openIndexedFile(fileId: number): Promise<{ ok: true } | Fail> {
  const checked = await resolveChecked(fileId)
  if (!checked.ok) return checked
  if (!isSafeToOpen(path.extname(checked.real).slice(1))) {
    return fail('NOT_OPENABLE', 'Recall does not launch this type of file because Windows may run it. Use "Show in folder" instead.')
  }
  const err = await shell.openPath(checked.real)
  return err ? fail('OPEN_FAILED', err) : { ok: true }
}

/** A folder found by voice may be opened only if it really is one of the added folders or inside one. */
async function checkedFolder(folderPath: string): Promise<string | undefined> {
  if (!isSafeLocalPath(folderPath)) return undefined
  let real: string
  try {
    real = await realpath(folderPath)
    if (!(await stat(real)).isDirectory()) return undefined
  } catch {
    return undefined
  }
  const status = await engine.call<{ folders: { path: string }[] }>('getStatus')
  const key = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase()
  return status.folders.some((f) => key(f.path) === key(real) || isInsideRoot(real, f.path)) ? real : undefined
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
