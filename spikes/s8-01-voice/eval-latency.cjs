// Wake latency: time from the end of the spoken word to the detection, on clips that end with "recall".
// Speech end = last 10 ms window above an energy floor. Frames are 100 ms, as in the app.
const { SR, createSpotter, manifest, readClip } = require('./common.cjs')
const kws = createSpotter({ score: 1.0, threshold: 0.15 })
const out = []
for (const c of manifest().filter((m) => m.set === 'wake' && /recall\.$/i.test(m.text))) {
  const clip = readClip(c.file)
  const lead = SR * 0.5
  const s = new Float32Array(lead + clip.length + SR * 1.5)
  s.set(clip, lead)
  let end = 0
  for (let i = 0; i + 160 <= clip.length; i += 160) {
    let e = 0
    for (let j = i; j < i + 160; j++) e += clip[j] * clip[j]
    if (Math.sqrt(e / 160) > 0.01) end = lead + i + 160
  }
  const st = kws.createStream()
  let hit
  for (let i = 0; i < s.length && hit === undefined; i += SR / 10) {
    st.acceptWaveform({ samples: s.subarray(i, i + SR / 10), sampleRate: SR })
    while (kws.isReady(st)) {
      kws.decode(st)
      if (kws.getResult(st).keyword) hit = i + SR / 10
    }
  }
  out.push(hit === undefined ? null : Math.round(((hit - end) / SR) * 1000))
}
const ok = out.filter((x) => x !== null).sort((a, b) => a - b)
console.log(JSON.stringify({ clips: out.length, detected: ok.length, msAfterWordEnd: ok, p50: ok[Math.floor(ok.length / 2)], max: ok.at(-1) }))
