import type { BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { EngineSupervisor } from './engine'
import type { AppStatus, SearchResponse } from '../shared/types'

/**
 * `--smoke-test=<folder>`: indexes a folder through the real engine process, runs a few searches,
 * checks that the renderer loaded without errors, prints a JSON summary and exits (0 = pass).
 */
export async function runSmokeTest(folder: string, engine: EngineSupervisor, win: BrowserWindow | undefined): Promise<number> {
  const rendererErrors: string[] = []
  win?.webContents.on('console-message', (e) => {
    if (e.level === 'error') rendererErrors.push(e.message)
  })
  const loaded = new Promise<boolean>((resolve) => {
    if (!win) return resolve(false)
    win.webContents.once('did-finish-load', () => resolve(true))
    win.webContents.once('did-fail-load', () => resolve(false))
  })
  const t0 = Date.now()
  try {
    await engine.call('addFolder', { path: folder })
    let status: AppStatus
    for (;;) {
      status = await engine.call<AppStatus>('getStatus')
      const p = status.progress
      const embedsDone = status.ai.state !== 'ready' || p.embedDone === p.embedTotal
      if (!p.scanning && p.filesPending === 0 && p.readTotal > 0 && p.readDone === p.readTotal && embedsDone) break
      if (Date.now() - t0 > 180_000) throw new Error('indexing timed out: ' + JSON.stringify(p))
      await new Promise((r) => setTimeout(r, 300))
    }
    const queries = ['proposal with a 50% initial payment', 'where I implemented authentication', 'dishwasher warranty period']
    const searches: { query: string; mode: string; top: string | undefined; ms: number }[] = []
    for (let i = 0; i < queries.length; i++) {
      const r = await engine.call<SearchResponse>('search', { requestId: i + 1, query: queries[i] })
      searches.push({ query: queries[i], mode: r.mode, top: r.results[0]?.primary.name, ms: r.tookMs })
    }
    await engine.call('checkConsistency')
    const rendererLoaded = await Promise.race([loaded, new Promise<boolean>((r) => setTimeout(() => r(false), 15_000))])
    const shotsDir = process.argv.find((a) => a.startsWith('--smoke-screenshots='))?.slice('--smoke-screenshots='.length)
    if (shotsDir && win && rendererLoaded) await captureScreens(win, shotsDir)
    const summary = { ok: rendererLoaded && rendererErrors.length === 0, indexMs: Date.now() - t0, ai: status.ai.state, progress: status.progress, searches, rendererLoaded, rendererErrors }
    console.log('SMOKE ' + JSON.stringify(summary, null, 2))
    return summary.ok ? 0 : 1
  } catch (err) {
    console.log('SMOKE FAILED ' + (err as Error).message)
    return 1
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Drives the real UI with synthetic input and saves PNGs, for visual review of each screen. */
async function captureScreens(win: BrowserWindow, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  const wc = win.webContents
  const shot = async (name: string) => writeFileSync(path.join(dir, name + '.png'), (await wc.capturePage()).toPNG())
  const click = (text: string) =>
    wc.executeJavaScript(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}))?.click()`
    )
  win.setSize(1280, 820)
  await wait(1200)
  await shot('1-onboarding')
  await click('Get started')
  await wait(600)
  await shot('2-onboarding-ai')
  await wc.executeJavaScript("localStorage.setItem('recall.onboarded', '1')")
  wc.reload()
  await wait(2000)
  await wc.executeJavaScript("document.querySelector('input[role=searchbox]').focus()")
  wc.insertText('proposal with a 50% initial payment')
  await wait(1500)
  await shot('3-search')
  await click('Details')
  await wait(800)
  await shot('4-details')
  await click('← Back')
  await click('Ask')
  await wait(500)
  await wc.executeJavaScript("document.querySelector('.ask-input').focus()")
  wc.insertText('What payment terms did I propose to Acme, and did they change?')
  await click('Ask')
  await wc.executeJavaScript("document.querySelector('.ask-form button[type=submit]')?.click()")
  for (let i = 0; i < 90; i++) {
    await wait(1000)
    if (await wc.executeJavaScript("!!document.querySelector('.disclaimer') || !!document.querySelector('.insufficient')")) break
  }
  await shot('5-ask')
  await click('Folders')
  await wait(800)
  await shot('6-folders')
  await click('Settings')
  await wait(800)
  await shot('7-settings')
}
