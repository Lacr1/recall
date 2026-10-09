// Read-aloud for the popup (plan 12 FR-VOICE-11, D-21): Windows voices that run on this computer only.
// A voice whose localService is false (an online voice) is never used, even when it is the default.

let pick: SpeechSynthesisVoice | undefined

function localVoice(): SpeechSynthesisVoice | undefined {
  if (pick) return pick
  const voices = speechSynthesis.getVoices().filter((v) => v.localService && v.lang.toLowerCase().startsWith('en'))
  pick = voices.find((v) => v.default) ?? voices[0]
  return pick
}

speechSynthesis.addEventListener?.('voiceschanged', () => (pick = undefined))

/** Speaks the text; resolves when it ends or is stopped. Nothing is spoken if no local voice exists. */
export function speak(text: string, onStart: () => void): Promise<void> {
  stopSpeaking()
  const voice = localVoice()
  if (!voice || !text) return Promise.resolve()
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text)
    u.voice = voice
    u.lang = voice.lang
    u.rate = 1.05
    u.onstart = () => onStart()
    u.onend = () => resolve()
    u.onerror = () => resolve()
    speechSynthesis.speak(u)
  })
}

export function stopSpeaking(): void {
  if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel()
}
