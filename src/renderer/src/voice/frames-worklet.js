// AudioWorklet: groups 128-sample render quanta into 1600-sample (100 ms at 16 kHz) frames for the voice process.
// Plain JS because worklets are loaded as-is by URL, outside the bundle.
class RecallFrames extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(1600)
    this.n = 0
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i]
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf)
        this.buf = new Float32Array(1600)
        this.n = 0
      }
    }
    return true
  }
}

registerProcessor('recall-frames', RecallFrames)
