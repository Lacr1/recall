// The wake word as speech-to-text writes it. Used by the voice process (is the request still to come? was a
// lone word the wake word the spotter missed?) and by main (what was asked?).

// How speech-to-text spells "Recall" when it mishears it, as one word or the end of two ("we call", "the call").
const HEARD_WAKE = /^(recall|recalls|recalled|recal|recol|recoil|record|regal|rical|ricol|call|calls|called|cal|col|cool|coal|kol|kall|kohl|caul)$/
// Words speech-to-text puts before it: greetings and the first syllable, misheard.
const BEFORE_WAKE = /^(hey|hi|ok|okay|oh|uh|um|a|ah|i|it|he|she|we|the|you|to|re|ree|ri|rea|will|real)$/

// An utterance that is only the wake word, as speech-to-text writes it. Stricter than HEARD_WAKE: a lone "call"
// or "cool" is too common to open the popup.
const WAKE_ALONE = /^((hey|hi|ok|okay)\s+)?(recall|recalled|re call|we call|we called|the call)$/

/** True when a whole utterance is just "Recall", said alone and transcribed as it or a usual mishearing. */
export function isHeardWakeWordAlone(text: string): boolean {
  return WAKE_ALONE.test(text.toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim())
}

/**
 * Removes the wake word from the start however it was misheard, keeping the rest as said.
 * "We call. Find my resume." → "Find my resume."; "The call." → "". Text without it is returned unchanged.
 */
export function stripHeardWakeWord(text: string): string {
  const words = text.trim().split(/\s+/)
  for (let i = 0; i < Math.min(words.length, 4); i++) {
    // "Re-call," → "recall"
    const w = words[i].toLowerCase().replace(/[^a-z]/g, '')
    if (HEARD_WAKE.test(w)) {
      const rest = words.slice(i + 1).join(' ').replace(/^[^\p{L}\p{N}]+/u, '')
      return rest.charAt(0).toUpperCase() + rest.slice(1)
    }
    if (!BEFORE_WAKE.test(w)) break
  }
  return text
}
