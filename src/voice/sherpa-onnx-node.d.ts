// The package ships JSDoc, not TypeScript types. This declares only the parts Recall uses.
declare module 'sherpa-onnx-node' {
  interface Waveform {
    samples: Float32Array
    sampleRate: number
  }
  interface OnlineStream {
    acceptWaveform(w: Waveform): void
  }
  export class KeywordSpotter {
    constructor(config: object)
    createStream(): OnlineStream
    isReady(stream: OnlineStream): boolean
    decode(stream: OnlineStream): void
    reset(stream: OnlineStream): void
    getResult(stream: OnlineStream): { keyword: string }
  }
  export class Vad {
    constructor(config: object, bufferSizeInSeconds: number)
    acceptWaveform(samples: Float32Array): void
    isEmpty(): boolean
    pop(): void
    front(enableExternalBuffer?: boolean): { start: number; samples: Float32Array }
    isDetected(): boolean
    reset(): void
    flush(): void
  }
  interface OfflineStream {
    acceptWaveform(w: Waveform): void
  }
  export class OfflineRecognizer {
    static createAsync(config: object): Promise<OfflineRecognizer>
    createStream(): OfflineStream
    decode(stream: OfflineStream): void
    getResult(stream: OfflineStream): { text: string }
  }
  export function readWave(filename: string, enableExternalBuffer?: boolean): Waveform
}
