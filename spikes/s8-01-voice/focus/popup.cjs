// Shows only an inactive popup at the pointer for 3 s, so an outside script can check the foreground window.
const { app, BrowserWindow, screen } = require('electron')
app.whenReady().then(async () => {
  const p = screen.getCursorScreenPoint()
  const w = new BrowserWindow({ x: p.x + 16, y: p.y + 16, width: 360, height: 120, show: false, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false })
  await w.loadURL('data:text/html,<body style="background:rgba(30,40,80,.92);color:white;font:16px sans-serif">Do you need me?</body>')
  w.showInactive()
  require('node:fs').writeFileSync(__dirname + '/.shown', JSON.stringify({ visible: w.isVisible(), focused: w.isFocused(), at: p }))
  setTimeout(() => app.exit(0), 3000)
})
