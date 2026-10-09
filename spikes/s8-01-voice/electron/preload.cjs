// Hands the transferred MessagePort to the page, the documented pattern for sandboxed renderers.
const { ipcRenderer } = require('electron')
ipcRenderer.on('audio-port', (e) => window.postMessage('audio-port', '*', e.ports))
