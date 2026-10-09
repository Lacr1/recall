# Voice model notices

Recall's voice feature runs these models on this computer. The files are added by `node scripts/fetch-voice-models.mjs` and shipped in the installer.

| Files | Model | Licence | Attribution |
|---|---|---|---|
| `kws/*` | Streaming zipformer, English, 20M ([icefall](https://github.com/k2-fsa/icefall/pull/903), exported for sherpa-onnx) | Apache-2.0 | Trained on LibriSpeech (V. Panayotov, G. Chen, D. Povey, S. Khudanpur, "LibriSpeech: an ASR corpus based on public domain audio books", ICASSP 2015), licensed CC BY 4.0 |
| `asr/*` | Moonshine tiny, English ([Useful Sensors](https://github.com/usefulsensors/moonshine)) | MIT (see `asr/LICENSE`) | Copyright (c) 2024 Useful Sensors |
| `silero_vad.onnx` | Silero VAD ([snakers4/silero-vad](https://github.com/snakers4/silero-vad)) | MIT | Copyright (c) 2020-present Silero Team |
| `keywords.txt` | The wake word "recall" as sub-word tokens of the `kws` model | Part of Recall | — |

The runtime is [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (`sherpa-onnx-node`, Apache-2.0), which includes ONNX Runtime (MIT).
