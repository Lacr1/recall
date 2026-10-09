import { app, MessageChannelMain } from 'electron'
import { readFileSync } from 'node:fs'
import { VoiceSupervisor } from './supervisor'
import { readPcm16Wav, toFrames } from '../../shared/wav'
import { VOICE_FRAME_SAMPLES, VOICE_SAMPLE_RATE, type VoiceEvent } from '../../shared/voice'

/**
 * `--voice-smoke=<wav>`: starts the real voice process with the bundled models, plays a 16 kHz WAV into it over
 * the audio port, prints a JSON summary and exits (0 = wake word and an utterance were heard).
 */
export async function runVoiceSmoke(wavPath: string, voiceDir: string): Promise<number> {
  const events: VoiceEvent[] = []
  const voice = new VoiceSupervisor(voiceDir, (e) => events.push(e))
  const t0 = Date.now()
  const waitFor = async (ok: () => boolean, ms: number) => {
    const end = Date.now() + ms
    while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
    return ok()
  }
  try {
    const wav = readPcm16Wav(readFileSync(wavPath))
    if (wav.sampleRate !== VOICE_SAMPLE_RATE) throw new Error(`WAV must be ${VOICE_SAMPLE_RATE} Hz`)
    voice.start()
    await waitFor(() => events.some((e) => e.event === 'ready' || e.event === 'problem'), 20_000)
    const ready = events.find((e) => e.event === 'ready')
    if (!ready) throw new Error('voice process not ready: ' + JSON.stringify(events))
    // Memory with only the wake-word model loaded, then again after speech-to-text has loaded for the request.
    const memoryMb = () => Math.round((app.getAppMetrics().find((p) => p.pid === voice.pid)?.memory.workingSetSize ?? 0) / 1024)
    await new Promise((r) => setTimeout(r, 1000))
    const idleMb = memoryMb()
    const { port1, port2 } = new MessageChannelMain()
    voice.attachAudio(port1)
    voice.send({ type: 'setListening', on: true })
    // Half a second of silence, the clip, then two seconds so the pause detector closes the utterance.
    const silence = new Float32Array(VOICE_FRAME_SAMPLES)
    const frames = [...Array(5).fill(silence), ...toFrames(wav.samples, VOICE_FRAME_SAMPLES), ...Array(20).fill(silence)]
    for (const f of frames) port2.postMessage(f)
    await waitFor(() => events.some((e) => e.event === 'utterance' && !/^\W*recall\W*$/i.test(e.text)), 15_000)
    const summary = {
      ok: events.some((e) => e.event === 'wake') && events.some((e) => e.event === 'utterance'),
      ms: Date.now() - t0,
      memoryMb: { idle: idleMb, afterRequest: memoryMb() },
      events
    }
    console.log('VOICE-SMOKE ' + JSON.stringify(summary, null, 2))
    return summary.ok ? 0 : 1
  } catch (err) {
    console.log('VOICE-SMOKE FAILED ' + (err as Error).message)
    return 1
  } finally {
    await voice.stop()
  }
}
