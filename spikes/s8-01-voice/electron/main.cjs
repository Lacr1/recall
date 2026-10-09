// Electron side of the S8-01 spike. Run: node_modules/.bin/electron spikes/s8-01-voice/electron/main.cjs
// Prints one JSON line per check and exits. Answers TA-10 (main + utilityProcess), TA-12, TA-13, TA-14.
const path = require('node:path')
const { app, BrowserWindow, MessageChannelMain, session, utilityProcess } = require('electron')
const { sherpa, AUDIO, SR, createSpotter, readClip, spot } = require('../common.cjs')

// Fake mic: 1 s silence, "Recall, find my resume.", 2 s silence (Chromium loops the file).
const FAKE_WAV = path.join(__dirname, '..', '.fake-mic.wav')
const clip = readClip('wake/01-David-r0.wav')
const padded = new Float32Array(SR * 3 + clip.length)
padded.set(clip, SR)
sherpa.writeWave(FAKE_WAV, { samples: padded, sampleRate: SR })
app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', FAKE_WAV)

const report = (check, data) => console.log(JSON.stringify({ check, ...data }))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  // Same shape as the planned hardenSession change: audio capture only, nothing else.
  const requested = []
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => {
    const ok = permission === 'media' && (details.mediaTypes ?? []).length > 0 && details.mediaTypes.every((t) => t === 'audio')
    requested.push({ permission, mediaTypes: details.mediaTypes, granted: ok })
    cb(ok)
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission, _origin, details) => permission === 'media' && details.mediaType === 'audio')

  // 1. Native addon in the main process.
  {
    const kws = createSpotter({ score: 1.0, threshold: 0.15 })
    const found = []
    spot(kws, kws.createStream(), padded, 0, found)
    report('main-process-kws', { ok: found.length > 0, detections: found.length, electron: process.versions.electron })
  }

  // 2. utilityProcess with the full pipeline.
  const child = utilityProcess.fork(path.join(__dirname, 'voice-child.cjs'), [], { serviceName: 'Recall voice spike', stdio: 'inherit' })
  const events = []
  child.on('message', (m) => events.push(m))
  while (!events.some((e) => e.event === 'loaded')) await wait(50)
  report('utility-process-load', events.find((e) => e.event === 'loaded'))

  // 3. Frames from a file, sent from main, to check the pipeline end to end.
  for (let i = 0; i < padded.length; i += SR / 10) child.postMessage({ type: 'frame', samples: padded.slice(i, i + SR / 10) })
  await wait(1500)
  report('utility-process-file-frames', { events: events.filter((e) => e.event !== 'loaded') })
  events.length = 0

  // 4. Mic capture in a window that is never shown, frames sent over a transferred MessagePort.
  const hidden = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: true } })
  const pageLog = []
  hidden.webContents.on('console-message', (e) => pageLog.push(e.message))
  await hidden.loadFile(path.join(__dirname, 'page.html'))
  const { port1, port2 } = new MessageChannelMain()
  child.postMessage({ type: 'port' }, [port1])
  hidden.webContents.postMessage('audio-port', null, [port2])
  const t0 = Date.now()
  // The looped file may start mid-word, so wait for a full pass that includes the wake word.
  app.getAppMetrics()
  while (Date.now() - t0 < 20000 && !events.some((e) => e.event === 'wake')) await wait(100)
  await wait(2500)
  const metrics = app.getAppMetrics().find((m) => m.pid === child.pid)
  child.postMessage({ type: 'rss' })
  await wait(200)
  report('hidden-window-capture', {
    ok: events.some((e) => e.event === 'wake') && events.some((e) => e.event === 'utterance'),
    events,
    visible: hidden.isVisible(),
    childCpuPercent: metrics?.cpu.percentCPUUsage,
    pageLog: pageLog.filter((l) => !l.startsWith('voices')).slice(0, 8)
  })

  // 5. Permission filter: the page also asked for video, which must be denied.
  report('permissions', { requested, videoDenied: pageLog.some((l) => l.startsWith('video: denied')) })

  // 6. Read-aloud voices.
  report('speech-synthesis', { lines: pageLog.filter((l) => l.startsWith('voices') || l.startsWith('speak')) })

  // 7. Popup shown without taking focus.
  const focused = new BrowserWindow({ width: 400, height: 300, show: true, title: 'Focused app stand-in' })
  await focused.loadURL('data:text/html,<input autofocus>')
  focused.focus()
  await wait(500)
  const popup = new BrowserWindow({ width: 360, height: 140, show: false, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, focusable: true })
  await popup.loadURL('data:text/html,<body style="background:rgba(30,40,80,.9);color:white;font:16px sans-serif">Do you need me?</body>')
  const { screen } = require('electron')
  const pt = screen.getCursorScreenPoint()
  popup.setPosition(pt.x + 16, pt.y + 16)
  popup.showInactive()
  await wait(700)
  report('popup-focus', { popupVisible: popup.isVisible(), popupFocused: popup.isFocused(), otherStillFocused: focused.isFocused(), focusedId: BrowserWindow.getFocusedWindow()?.id === focused.id, cursor: pt })

  child.kill()
  app.exit(0)
})
