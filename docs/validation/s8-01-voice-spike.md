# S8-01: Speech stack spike

> Date: 2026-10-09 · Machine: AMD Ryzen 7 5700G, 15.4 GB RAM, Windows 10 19045 · Node 24.21.0, Electron 44.7.0 · `sherpa-onnx-node` 1.13.8 · Spike code: `spikes/s8-01-voice/` (see its README to reproduce)
>
> Method: 378 synthetic 16 kHz clips made with the two Windows voices (David, Zira) at three speaking rates. There are 48 clips with the wake word, 36 that use "recall" in other ways, 234 everyday sentences (17.3 min, including near-sounds like "Rebecca will call", "recheck", "the record was all wrong"), and 60 file/question requests. Frames are fed in 100 ms blocks as the app will.
>
> **Caveat:** synthetic speech is clean and evenly paced, so every accuracy number here is a best case. Real voices, laptop microphones and noisy rooms are measured in S8-11. Treat these numbers as "the pipeline works and is cheap", not "it will work for every user".

## Results

### Wake word ("recall", open-vocabulary keyword spotting, no training)

| Keyword model | Setting (score, threshold) | Wake detected | False wakes (17.3 min) | "recall" in other uses | CPU (one core) | Latency after word, p50 / max |
|---|---|---|---|---|---|---|
| KWS zipformer, GigaSpeech, 3.3M | 1.0, 0.15 | 48/48 | 0 | 32/36 | 1.7% | 620 / 740 ms |
| **Streaming zipformer, LibriSpeech, 20M** | **1.5, 0.15** | **48/48** | **0** | 27/36 | 2.9% | 630 / 730 ms |
| Streaming zipformer, LibriSpeech, 20M | 1.0, 0.15 | 47/48 | 0 | 16/36 | 2.9% | — |

- **The spotter must be reset after each pause.** On one never-reset stream, detection fell to 58%. Resetting at each silence, which the VAD already reports, brings it to 100%. This is a required part of the pipeline design.
- Sentences that say "recall" in other ways ("I can't recall his name") still trigger it, as expected. The confirmation popup is what makes those harmless.
- Latency includes up to 100 ms of frame buffering. Both models need about 0.5 s of trailing audio after the word before they decide.

### Speech-to-text (60 request clips, 2.8 s average)

| Model | Word error rate | Exact transcripts | Latency p50 / p95 | Files (int8) | Memory added | Licence |
|---|---|---|---|---|---|---|
| **Moonshine tiny (en, int8)** | **2.1%** | 55/60 | **47 / 53 ms** | 124 MB | 180 MB | MIT |
| Whisper tiny.en (int8) | 9.3% | 51/60 | 190 / 233 ms | 104 MB | 258 MB | MIT |
| Whisper base.en (int8) | 5.8% | 55/60 | 356 / 400 ms | 161 MB | 381 MB | MIT |

- Whisper repeats itself on short clips ("Open the quarterly report. Open the quarterly report." and once "Who Who Who…"). Moonshine's errors were small: "least" for "lease", "Some arise" for "summarize", "mock-ups".
- Moonshine loads in about 0.7 s.

### Electron contexts (TA-10, TA-12, TA-13, TA-14)

| Check | Result |
|---|---|
| Addon in plain Node | pass |
| Addon in Electron main | pass |
| Addon in `utilityProcess` (KWS + VAD + Moonshine) | pass: loads in 1.6 s; wake + transcript from frames |
| **Packaged app** (`electron-builder --dir`, addon JS in `app.asar`, `sherpa-onnx-win-x64/**` unpacked, models in `resources/voice`) | pass: wake detected, transcript "Recall find my resume" |
| Mic capture in a **never-shown** window (Chromium fake device), AudioWorklet at 16 kHz, frames over a transferred `MessagePort` straight to the voice process | pass: wake detected, transcript arrived, window stayed hidden |
| Permission filter: audio only | pass: audio granted, video request denied (`NotAllowedError`) |
| `speechSynthesis` voices | pass: Microsoft David, Mark and Zira, all `localService: true`; speaking completes |
| Popup with `showInactive()` | pass: popup visible, not focused; **Notepad stayed the foreground window** throughout (checked with `GetForegroundWindow`) |

### Cost

| | Measured |
|---|---|
| Voice process memory, all models loaded (Electron) | 278–291 MB with the GigaSpeech KWS model. LibriSpeech adds about 35 MB (Node measurement: 228 → 266 MB) |
| CPU while listening | 1.7–2.9% of one core (Node); 0.5% reported by `app.getAppMetrics()` in Electron |
| Files to ship (LibriSpeech KWS + VAD + Moonshine + addon) | ~186 MB on disk, **~132 MB compressed** (xz -6, close to NSIS LZMA). Installer ≈ 138 → ~270 MB |

## Decisions

- **D-16 → (a) sherpa-onnx, confirmed.** One Apache-2.0 dependency covers the wake word, end-of-speech detection and speech-to-text, and it works in all four contexts.
- **D-17 → (a) bundle, confirmed.** Cost: about 132 MB more installer.
- **Speech-to-text → Moonshine tiny.** It is the most accurate and fastest of the three candidates, and MIT-licensed.
- **New decision D-25, keyword model → LibriSpeech streaming zipformer (recommended).**
  - The small KWS model is labelled Apache-2.0, but it was trained on GigaSpeech, which is licensed for non-commercial research only.
  - The LibriSpeech model is Apache-2.0 and trained on LibriSpeech (CC BY 4.0, commercial use allowed with attribution). Its accuracy is the same on this set.
  - It costs 41 MB of files and about 35 MB more memory.
- **Memory:** loading everything uses about 320 MB in Electron, above the 250 MB target. Proposed fix for S8-02:
  - Load Moonshine only on the wake word. The 0.7 s load overlaps with the user still speaking.
  - Unload it after 2 minutes idle.
  - Idle listening then needs only the keyword model and VAD (about 130 MB). NFR-V-05 is revised to ≤ 150 MB idle and ≤ 350 MB during a request.
- **Wake latency:** NFR-V-03 is revised from ≤ 500 ms to **≤ 800 ms after the word ends**, because the models need trailing audio. The popup window is created ahead of time and only shown, so it adds almost nothing.

## Required by the implementation (carried into S8-02/03)

- Pass `enableExternalBuffer = false` to every sherpa call that returns samples (`readWave`, `Vad.front`). Electron's V8 memory cage rejects external buffers ("External buffers are not allowed").
- Reset the keyword stream after each VAD-detected pause.
- The VAD splits "Recall, find my resume" at the comma, so the session joins the wake segment with the next one. The wake word is stripped from the transcript.
- `asarUnpack: node_modules/sherpa-onnx-win-x64/**`. The addon loads `onnxruntime.dll` and the sherpa DLLs from its own folder, so the existing `**/*.node` pattern is not enough.
- The keyword spotter reads keywords from a file, so `keywords.txt` ships in `resources/voice/`.
- In the dev shell, `ELECTRON_RUN_AS_NODE=1` is set (the VS Code host). Launch Electron with it removed, as `scripts/run.mjs` does.
- Through Chromium's capture path, one transcript was "Mind my resume" instead of "Find my resume". S8-03 compares `noiseSuppression` / `autoGainControl` on and off with real recordings.

## Not verified

- Real human speech (accents, laptop mics, background noise) and an hour-long false-wake run on real audio (NFR-V-01/02 on real data). This is S8-11.
- Model files are not checked into the repo. The README lists the download URLs and the dev setup step for S8-02.
- Windows 11 was not tested.

## Assumption status

| ID | Status |
|---|---|
| TA-10 | **Verified**: Node, main, `utilityProcess`, packaged |
| TA-11 | **Verified on synthetic speech** (48/48, 0 false wakes); real speech pending S8-11 |
| TA-12 | **Verified** with Chromium's fake capture device; a real microphone is checked in S8-03 |
| TA-13 | **Verified**: three local SAPI voices |
| TA-14 | **Verified** against Notepad on Windows 10 |
| TA-15 | **Verified with one caveat**: addon Apache-2.0 (bundles onnxruntime, MIT), Moonshine MIT, Silero VAD MIT, LibriSpeech model Apache-2.0 with CC BY 4.0 data. The GigaSpeech KWS model's training data is non-commercial (D-25) |

Sources: [sherpa-onnx-node](https://classic.yarnpkg.com/en/package/sherpa-onnx-node), [GigaSpeech terms](https://huggingface.co/datasets/distil-whisper/gigaspeech-l-token-ids/blob/main/README.md), [Moonshine licence](https://github.com/usefulsensors/moonshine/blob/main/LICENSE).
