// The real voice models on synthetic fixture speech (plan 12 S8-02). Needs resources/voice:
// run `node scripts/fetch-voice-models.mjs` first.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { VoicePipeline } from '../../src/voice/pipeline'
import { createSherpaModels, missingVoiceFiles } from '../../src/voice/sherpa-models'
import { VOICE_FRAME_SAMPLES, type VoiceEvent } from '../../src/shared/voice'
import { readPcm16Wav, toFrames } from '../../src/shared/wav'

const VOICE_DIR = path.resolve('resources/voice')

async function play(file: string): Promise<VoiceEvent[]> {
  const events: VoiceEvent[] = []
  const p = new VoicePipeline(createSherpaModels(VOICE_DIR), (e) => events.push(e))
  p.command({ type: 'setListening', on: true })
  const { samples } = readPcm16Wav(readFileSync(path.join('tests/fixtures/voice', file)))
  const silence = new Float32Array(VOICE_FRAME_SAMPLES)
  for (const f of [...Array(5).fill(silence), ...toFrames(samples, VOICE_FRAME_SAMPLES), ...Array(20).fill(silence)]) p.frame(f)
  await p.idle()
  return events
}

describe('voice models', () => {
  it('are all present', () => {
    expect(missingVoiceFiles(VOICE_DIR), 'run node scripts/fetch-voice-models.mjs').toEqual([])
  })

  it('hear the wake word and the request in one breath', async () => {
    const events = await play('recall-find-my-resume.wav')
    expect(events[0]).toEqual({ event: 'wake' })
    const text = events.filter((e) => e.event === 'utterance').map((e) => (e as { text: string }).text).join(' ')
    expect(text.toLowerCase()).toContain('find my resume')
  })

  it('hear the wake word said alone', async () => {
    const events = await play('recall.wav')
    expect(events.filter((e) => e.event === 'wake')).toHaveLength(1)
  })

  it('stay quiet for speech without the wake word', async () => {
    const events = await play('rachel-called.wav')
    expect(events).toEqual([])
  })
})
