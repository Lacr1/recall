# Voice fixtures

Synthetic speech made with the Windows "Microsoft David" and "Microsoft Zira" voices by `spikes/s8-01-voice/make-audio.ps1` (16 kHz, 16-bit PCM, mono). No real person's voice; safe to commit.

| File | Says | Voice |
|---|---|---|
| `recall-find-my-resume.wav` | "Recall, find my resume." | David |
| `recall.wav` | "Recall." | Zira |
| `rachel-called.wav` | "Rachel called about the rental car." (no wake word) | David |
| `fake-mic-loop.wav` | 1.5 s silence, "Recall, find my resume.", 2.5 s silence; played in a loop as Chromium's fake microphone in `tests/e2e/voice.spec.ts` | David |
| `fake-mic-dishwasher.wav` | 1.5 s silence, "Recall, find the dishwasher manual.", 4 s silence; fake microphone for the end-to-end file flow | David |
