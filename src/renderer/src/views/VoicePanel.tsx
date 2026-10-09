import { useEffect, useState } from 'react'
import type { AppStatus } from '../../../shared/types'
import type { VoiceSensitivity, VoiceSettings, VoiceStatus } from '../../../shared/voice'

type Message = { text: string; mic?: boolean }

/** What the user is told for a voice problem, and whether the switch goes back to Off (plan 12 §5.2). */
function problemMessage(problem: VoiceStatus['problem']): { message: Message; turnOff: boolean } | undefined {
  switch (problem) {
    case 'MIC_BLOCKED':
      return { message: { text: 'Windows is blocking the microphone for desktop apps.', mic: true }, turnOff: true }
    case 'NO_MIC':
      return { message: { text: 'No microphone found. Plug one in, then turn voice on again.' }, turnOff: true }
    case 'MIC_FAILED':
      return { message: { text: "The microphone didn't start. Try turning voice off and on again.", mic: true }, turnOff: true }
    case 'MODELS_MISSING':
    case 'MODELS_DAMAGED':
      return { message: { text: 'Voice files are damaged. Reinstall Recall to use voice.' }, turnOff: true }
    case 'VOICE_CRASHED':
      return { message: { text: 'Voice stopped working. Turn it on again to retry.' }, turnOff: true }
    case 'MIC_LOST':
      return { message: { text: 'The microphone was disconnected. Recall will listen again when it is back.' }, turnOff: false }
    default:
      return undefined
  }
}

const SENSITIVITY: { value: VoiceSensitivity; label: string; hint: string }[] = [
  { value: 'lower', label: 'Lower', hint: 'Fewer accidental pop-ups' },
  { value: 'normal', label: 'Normal', hint: 'Recommended' },
  { value: 'higher', label: 'Higher', hint: 'Hears “Recall” more easily' }
]

/**
 * The Voice On / Off switch and its options, shared by onboarding (step 4) and Settings → Voice (plan 12 §5.2, §5.3).
 * The microphone only opens while the switch is On; main reports the state back.
 */
export function VoicePanel({ status, mode }: { status: AppStatus; mode: 'onboarding' | 'settings' }) {
  const [voice, setVoice] = useState<VoiceStatus>()
  const [heard, setHeard] = useState(false)
  const [level, setLevel] = useState(0)
  const [message, setMessage] = useState<Message>()

  useEffect(() => {
    void window.recall.getVoiceStatus().then(setVoice)
    return window.recall.onEvent((e) => {
      if (e.event === 'voice') setVoice(e.data)
      else if (e.event === 'voiceWake') setHeard(true)
      else if (e.event === 'voiceLevel') setLevel((l) => Math.max(e.rms, l * 0.6))
    })
  }, [])

  const listening = voice?.state === 'listening'
  // The mic meter runs only while this panel is showing and voice is listening.
  useEffect(() => {
    if (!listening) return
    void window.recall.setVoiceMeter(true)
    const decay = setInterval(() => setLevel((l) => l * 0.6), 120)
    return () => {
      clearInterval(decay)
      void window.recall.setVoiceMeter(false)
    }
  }, [listening])

  useEffect(() => {
    const p = problemMessage(voice?.problem)
    if (!p) return
    setMessage(p.message)
    if (p.turnOff) void window.recall.setVoiceSettings({ enabled: false }).then(setVoice)
  }, [voice?.problem])

  if (!voice) return null
  const on = voice.settings.enabled
  // Shown at once, then replaced by what main actually applied.
  const set = (patch: Partial<VoiceSettings>) => {
    setVoice((v) => v && { ...v, settings: { ...v.settings, ...patch } })
    void window.recall.setVoiceSettings(patch).then(setVoice)
  }
  const turnOn = () => {
    setMessage(undefined)
    setHeard(false)
    set({ enabled: true })
  }
  const answersNeedModel = status.ai.state !== 'ready' || !status.ai.chatAvailable
  const bars = Math.min(7, Math.round(Math.sqrt(level / 0.08) * 7))

  return (
    <div className="voice-panel">
      <div className="voice-switch" role="radiogroup" aria-labelledby={`voice-label-${mode}`}>
        <span className="voice-switch-label" id={`voice-label-${mode}`}>
          Voice
        </span>
        <label className={`seg ${on ? '' : 'selected'}`}>
          <input type="radio" name={`voice-${mode}`} checked={!on} onChange={() => set({ enabled: false })} />
          Off
        </label>
        <label className={`seg ${on ? 'selected' : ''}`}>
          <input type="radio" name={`voice-${mode}`} checked={on} onChange={turnOn} />
          On
        </label>
      </div>
      <p className="voice-privacy">Listening happens on this computer. Audio is never saved or sent anywhere.</p>

      {message && (
        <div className="banner banner-warn" role="alert">
          {message.text}
          {message.mic && (
            <button className="link" onClick={() => void window.recall.openMicSettings()}>
              Open Windows microphone settings
            </button>
          )}
        </div>
      )}

      {!on && (
        <p className="hint">{mode === 'onboarding' ? 'You can turn voice on later in Settings → Voice.' : 'Turn voice on to say “Recall” from any app.'}</p>
      )}

      {on && (
        <>
          <div className="voice-practice">
            <span className="voice-state">
              {voice.state === 'starting' && 'Starting voice…'}
              {voice.state === 'listening' && 'Try it: say “Recall”'}
              {voice.state === 'muted' && 'Muted. Recall is not listening.'}
              {voice.state === 'problem' && 'Voice needs attention.'}
            </span>
            {listening && (
              <span className="voice-meter" role="img" aria-label={bars > 2 ? 'Microphone is hearing sound' : 'Microphone is quiet'}>
                {Array.from({ length: 7 }, (_, i) => (
                  <span key={i} className={i < bars ? 'on' : ''} style={{ height: `${6 + i * 2}px` }} />
                ))}
              </span>
            )}
            <span className="voice-heard" aria-live="polite">
              {heard && '✓ Heard you'}
            </span>
          </div>
          {heard && <p className="hint">A small window appeared next to your mouse pointer. Say what you need, or “no” to close it.</p>}
          <label className="check">
            <input type="checkbox" checked={voice.settings.readAloud} onChange={(e) => set({ readAloud: e.target.checked })} />
            Read replies aloud
          </label>
          <label className="check">
            <input type="checkbox" checked={voice.settings.startWithWindows} onChange={(e) => set({ startWithWindows: e.target.checked })} />
            Start Recall when Windows starts
          </label>
          {mode === 'settings' && (
            <>
              <label className="check">
                <input type="checkbox" checked={voice.settings.muted} onChange={(e) => set({ muted: e.target.checked })} />
                Mute until I unmute
              </label>
              <label className="voice-select">
                Wake word sensitivity
                <select value={voice.settings.sensitivity} onChange={(e) => set({ sensitivity: e.target.value as VoiceSensitivity })}>
                  {SENSITIVITY.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}: {s.hint}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <p className="hint">Closing the window keeps Recall in the tray so it can listen. Quit from the tray icon.</p>
          {answersNeedModel && <p className="hint">Finding files by voice works now. Answering questions needs the answer model.</p>}
        </>
      )}
    </div>
  )
}
