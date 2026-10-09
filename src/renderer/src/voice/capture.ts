// Microphone capture for voice (plan 12 §6.1). Main hands over a MessagePort when voice is on and unmuted; this
// module opens the mic at 16 kHz and sends 100 ms Float32 frames on that port, straight to the voice process.
// Audio never goes anywhere else and is never stored. The port is withdrawn ("stop") when voice is off or muted.
// no-inline: a data: URL would be blocked by the page's CSP (script-src 'self').
import workletUrl from './frames-worklet.js?url&no-inline'
import { micProblemFromError } from '../../../shared/voice'

let port: MessagePort | undefined
let stream: MediaStream | undefined
let ctx: AudioContext | undefined
let waitingForDevice = false
// Bumped whenever the port changes or capture stops; an open() that started earlier then gives up quietly.
let generation = 0

export function initVoiceCapture(): void {
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || typeof e.data !== 'object') return
    const kind = (e.data as { recallAudio?: string }).recallAudio
    if (kind === 'port' && e.ports[0]) {
      stop()
      port = e.ports[0]
      void open()
    } else if (kind === 'stop') {
      stop()
      port?.close()
      port = undefined
    }
  })
  // A microphone plugged in (or back) after a failure: try again.
  navigator.mediaDevices?.addEventListener('devicechange', () => {
    if (waitingForDevice && port) {
      stop()
      void open()
    }
  })
}

async function open(): Promise<void> {
  const mine = ++generation
  const stale = () => mine !== generation
  try {
    // Echo cancellation keeps Recall from hearing its own read-aloud replies.
    const s = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    })
    if (stale() || !port) {
      s.getTracks().forEach((t) => t.stop())
      return
    }
    stream = s
    const context = new AudioContext({ sampleRate: 16000 })
    ctx = context
    await context.audioWorklet.addModule(workletUrl)
    if (stale()) {
      s.getTracks().forEach((t) => t.stop())
      void context.close().catch(() => undefined)
      return
    }
    const node = new AudioWorkletNode(context, 'recall-frames')
    node.port.onmessage = (ev) => port?.postMessage(ev.data)
    context.createMediaStreamSource(s).connect(node)
    s.getAudioTracks()[0]?.addEventListener('ended', () => {
      stop()
      report({ code: 'MIC_LOST' })
    })
    waitingForDevice = false
    report({ ok: true })
  } catch (err) {
    if (stale()) return
    stop()
    console.warn('[voice] microphone could not open:', (err as Error).name, (err as Error).message)
    const code = micProblemFromError((err as Error).name)
    waitingForDevice = code === 'NO_MIC'
    report({ code })
  }
}

function stop(): void {
  generation++
  stream?.getTracks().forEach((t) => t.stop())
  stream = undefined
  void ctx?.close().catch(() => undefined)
  ctx = undefined
}

function report(r: { ok: true } | { code: ReturnType<typeof micProblemFromError> }): void {
  if (r && 'code' in r && r.code === 'MIC_LOST') waitingForDevice = true
  void window.recall.voiceCapture(r).catch(() => undefined)
}
