// Captures the (fake) mic at 16 kHz in an AudioWorklet and forwards 100 ms Float32 frames to the voice process.
let port
window.addEventListener('message', (e) => {
  if (e.data === 'audio-port' && e.ports[0]) {
    port = e.ports[0]
    start()
  }
})

async function start() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    const ctx = new AudioContext({ sampleRate: 16000 })
    await ctx.audioWorklet.addModule('worklet.js')
    const node = new AudioWorkletNode(ctx, 'frames')
    node.port.onmessage = (e) => port.postMessage({ type: 'frame', samples: e.data })
    ctx.createMediaStreamSource(stream).connect(node)
    console.log(`capture: started at ${ctx.sampleRate} Hz, state ${ctx.state}, track "${stream.getAudioTracks()[0].label}"`)
  } catch (err) {
    console.log('capture: failed ' + err.name + ' ' + err.message)
  }
  try {
    await navigator.mediaDevices.getUserMedia({ video: true })
    console.log('video: granted (should not happen)')
  } catch (err) {
    console.log('video: denied ' + err.name)
  }
}

function listVoices() {
  const voices = speechSynthesis.getVoices()
  console.log('voices ' + JSON.stringify(voices.map((v) => ({ name: v.name, lang: v.lang, localService: v.localService, default: v.default }))))
  const local = voices.find((v) => v.localService && v.lang.startsWith('en'))
  if (!local) return
  const u = new SpeechSynthesisUtterance('Copied the path.')
  u.voice = local
  u.volume = 0
  u.onend = () => console.log('speak: ended with ' + local.name)
  u.onerror = (e) => console.log('speak: error ' + e.error)
  speechSynthesis.speak(u)
}
// Voices can load late; poll for up to 5 s.
let tries = 0
const poll = setInterval(() => {
  if (speechSynthesis.getVoices().length || ++tries > 50) {
    clearInterval(poll)
    listVoices()
  }
}, 100)
