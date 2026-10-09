// Reads 16-bit PCM mono WAV files into float samples. Used for voice test fixtures and the voice smoke run.

export function readPcm16Wav(buf: Uint8Array): { samples: Float32Array; sampleRate: number } {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const tag = (at: number) => String.fromCharCode(buf[at], buf[at + 1], buf[at + 2], buf[at + 3])
  if (buf.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file')
  let sampleRate = 0
  let at = 12
  while (at + 8 <= buf.length) {
    const id = tag(at)
    const size = view.getUint32(at + 4, true)
    const body = at + 8
    if (id === 'fmt ') {
      const format = view.getUint16(body, true)
      const channels = view.getUint16(body + 2, true)
      const bits = view.getUint16(body + 14, true)
      if (format !== 1 || channels !== 1 || bits !== 16) throw new Error('Only 16-bit PCM mono WAV is supported')
      sampleRate = view.getUint32(body + 4, true)
    } else if (id === 'data') {
      if (!sampleRate) throw new Error('WAV data before format')
      const n = Math.floor(Math.min(size, buf.length - body) / 2)
      const samples = new Float32Array(n)
      for (let i = 0; i < n; i++) samples[i] = view.getInt16(body + i * 2, true) / 32768
      return { samples, sampleRate }
    }
    at = body + size + (size % 2)
  }
  throw new Error('WAV file has no audio data')
}

/** Splits samples into fixed-size frames, padding the last one with silence. */
export function toFrames(samples: Float32Array, size: number): Float32Array[] {
  const frames: Float32Array[] = []
  for (let i = 0; i < samples.length; i += size) {
    const f = new Float32Array(size)
    f.set(samples.subarray(i, i + size))
    frames.push(f)
  }
  return frames
}
