// Runs electron-vite with ELECTRON_RUN_AS_NODE removed. Some hosts (e.g. VS Code
// extension terminals) set it, which makes Electron start as plain Node.
import { spawn } from 'node:child_process'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn('npx', ['electron-vite', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32'
})
child.on('exit', (code) => process.exit(code ?? 0))
