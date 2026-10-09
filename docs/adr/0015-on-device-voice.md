# ADR-0015: On-device voice with sherpa-onnx in its own utilityProcess

**Status:** Accepted (2026-10-09) for the speech stack, validated by the S8-01 spike on synthetic speech. Accuracy on real voices is still pending (S8-11).

**Context.** Plan [12](../app-plan/12-voice-assistant.md) adds a "Recall" wake word, spoken requests and read-aloud answers. Recall is local-first ([ADR-0013](0013-loopback-network-policy.md)): no cloud speech services, and no runtime downloads by Recall's own processes. Shipped models must have licences allowed by D-04.

**Decision.**
- **Library:** `sherpa-onnx-node` (Apache-2.0, prebuilt Windows x64) for:
  - Wake word: open-vocabulary keyword spotting with the LibriSpeech streaming zipformer 20M (int8), keyword "recall" (D-25).
  - End-of-speech detection: Silero VAD.
  - Speech-to-text: Moonshine tiny English (int8).
- **Where it runs:** its own `utilityProcess`, supervised like the engine. A native crash or a slow transcription never affects indexing or search.
- **Audio path:** captured in the main window's renderer (getUserMedia + AudioWorklet at 16 kHz) and sent over a `MessagePort` transferred straight to the voice process. Audio never passes through IPC handlers and is never written to disk.
- **Shipping:** models are bundled in `resources/voice/`, and the addon package is unpacked from the asar archive.
- **Read-aloud:** Chromium `speechSynthesis`, limited to voices with `localService: true`.

**Alternatives.**
- **openWakeWord + whisper.cpp.** Needs a custom wake-word model trained with Python, and models trained on its standard data are CC-BY-NC-SA.
- **Picovoice Porcupine.** Its licence key is validated online.
- **Whisper tiny/base.** Less accurate than Moonshine on short requests, slower, and repeats itself.
- **sherpa-onnx's small KWS model.** Its GigaSpeech training data is non-commercial.

**Consequences.**
- About 132 MB more installer (compressed).
- The voice process uses about 130 MB while idle-listening, once speech-to-text loads only on the wake word, and about 320 MB during a request.
- Wake latency is about 0.6 s after the word.
- The keyword stream must be reset at each pause.
- Every sample-returning call needs `enableExternalBuffer = false` under Electron.

**Evidence:** [s8-01-voice-spike.md](../validation/s8-01-voice-spike.md).
