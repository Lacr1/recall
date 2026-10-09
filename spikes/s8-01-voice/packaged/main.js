const path = require('node:path')
const fs = require('node:fs')
const { app, utilityProcess } = require('electron')
const out = path.join(path.dirname(process.execPath), 'result.json')
app.whenReady().then(() => {
  const child = utilityProcess.fork(path.join(__dirname, 'child.js'), [], { stdio: 'pipe' })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  child.stdout.on('data', (d) => (stderr += d))
  const done = (r) => { fs.writeFileSync(out, JSON.stringify({ ...r, stderr: stderr.slice(0, 1500) })); app.exit(0) }
  child.on('message', (m) => done({ ok: true, packaged: app.isPackaged, asar: __dirname.includes('app.asar'), ...m }))
  child.on('exit', (code) => setTimeout(() => done({ ok: false, exitCode: code }), 300))
  setTimeout(() => done({ ok: false, timeout: true }), 30000)
})
