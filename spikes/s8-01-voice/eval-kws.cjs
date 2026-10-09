// Wake-word accuracy and cost. All clips are fed as one continuous stream with gaps, like live listening,
// and each detection is attributed to the clip it falls in. Usage: node eval-kws.cjs [score,threshold ...]
const { SR, createSpotter, manifest, readClip, spot } = require('./common.cjs')

const GAP = new Float32Array(SR * 0.6)
const RESET = process.env.NO_RESET !== '1'
// Any sentence that contains the word counts as an other use, whatever set it was generated in.
const clips = manifest().map((m) => ({ ...m, set: m.set !== 'wake' && /recall/i.test(m.text) ? 'otherUses' : m.set, samples: readClip(m.file) }))

const configs = process.argv.slice(2).length
  ? process.argv.slice(2).map((a) => a.split(',').map(Number))
  : [[1.0, 0.2], [1.5, 0.2], [1.5, 0.25], [1.5, 0.3], [2.0, 0.25], [2.0, 0.35]]

for (const [score, threshold] of configs) {
  const kws = createSpotter({ score, threshold })
  const stream = kws.createStream()
  const hits = { wake: 0, otherUses: 0, negative: 0, requests: 0 }
  const totals = { wake: 0, otherUses: 0, negative: 0, requests: 0 }
  const negativeHits = []
  let sec = 0
  let audioSec = 0
  const t0 = process.cpuUsage()
  const w0 = performance.now()
  for (const c of clips) {
    const found = []
    spot(kws, stream, c.samples, sec, found)
    spot(kws, stream, GAP, sec + c.samples.length / SR, found)
    // The app resets the spotter after each pause the VAD reports; a never-reset stream drifts and misses.
    if (RESET) kws.reset(stream)
    totals[c.set]++
    if (found.length) {
      hits[c.set]++
      if (c.set === 'negative' || c.set === 'requests') negativeHits.push(c.text)
    }
    const len = (c.samples.length + GAP.length) / SR
    sec += len
    audioSec += len
  }
  const cpu = process.cpuUsage(t0)
  const cpuSec = (cpu.user + cpu.system) / 1e6
  const pct = (a, b) => ((100 * a) / b).toFixed(1) + '%'
  const nonWakeMin = clips.filter((c) => c.set === 'negative' || c.set === 'requests').reduce((s, c) => s + (c.samples.length + GAP.length) / SR, 0) / 60
  console.log(
    JSON.stringify({
      score,
      threshold,
      wakeDetected: `${hits.wake}/${totals.wake} (${pct(hits.wake, totals.wake)})`,
      otherUsesTriggered: `${hits.otherUses}/${totals.otherUses}`,
      falseWakes: `${hits.negative + hits.requests}/${totals.negative + totals.requests} clips in ${nonWakeMin.toFixed(1)} min`,
      falseWakeTexts: [...new Set(negativeHits)],
      audioMin: +(audioSec / 60).toFixed(1),
      cpuPerAudioSec: +(cpuSec / audioSec).toFixed(4),
      wallMs: Math.round(performance.now() - w0)
    })
  )
}
