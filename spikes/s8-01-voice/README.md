# S8-01 speech stack spike

Spike code for [plan 12](../../docs/app-plan/12-voice-assistant.md); results in [s8-01-voice-spike.md](../../docs/validation/s8-01-voice-spike.md). Never imported by `src/`. Models and generated audio are git-ignored.

## Recreate

```sh
cd spikes/s8-01-voice
npm install                                   # sherpa-onnx-node 1.13.8 (+ win-x64 binary)
mkdir models && cd models
B=https://github.com/k2-fsa/sherpa-onnx/releases/download
for u in kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2 \
         asr-models/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17.tar.bz2 \
         asr-models/sherpa-onnx-moonshine-tiny-en-int8.tar.bz2 \
         asr-models/sherpa-onnx-whisper-tiny.en.tar.bz2 \
         asr-models/sherpa-onnx-whisper-base.en.tar.bz2 \
         asr-models/silero_vad.onnx; do curl -sSLO "$B/$u"; done
for f in *.tar.bz2; do tar xjf "$f" && rm "$f"; done
cd ..
powershell -File make-audio.ps1               # 378 synthetic clips from phrases.json (Windows voices)
```

## Run

| Script | Measures |
|---|---|
| `KWS_MODEL=librispeech node eval-kws.cjs 1.5,0.15` | Wake detection, false wakes, CPU per audio second (`KWS_MODEL=gigaspeech` for the small model) |
| `KWS_MODEL=librispeech node eval-latency.cjs` | Time from end of the word to detection |
| `node eval-asr.cjs moonshine-tiny` | Word error rate, latency, size, memory (`whisper-tiny`, `whisper-base`) |
| `env -u ELECTRON_RUN_AS_NODE ../../node_modules/.bin/electron electron/main.cjs` (from repo root: `spikes/s8-01-voice/electron/main.cjs`) | Main process, `utilityProcess`, hidden-window capture, permissions, voices, popup focus |
| `packaged/`: `npm install`, then `electron-builder --win dir -c.electronVersion=44.7.0 -c.electronDist=<repo>/node_modules/electron/dist`, run `dist/win-unpacked/VoiceSpike.exe`, read `result.json` | Addon and models in a packaged app (uses the GigaSpeech KWS model; the packaging layout is the same for either) |
| `focus/check.ps1 <electron.exe> <focus/popup.cjs>` | Popup shown inactive keeps another app (Notepad) in the foreground |
