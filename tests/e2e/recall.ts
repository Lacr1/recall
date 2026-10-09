import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { cpSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { AppStatus } from '../../src/shared/types'

const ROOT = path.resolve(__dirname, '../..')
const AXE_SOURCE = readFileSync(createRequire(__filename).resolve('axe-core/axe.min.js'), 'utf8')

export interface RecallRun {
  app: ElectronApplication
  page: Page
  dataDir: string
  corpus: string
  /** Paths passed to shell.openPath / showItemInFolder, in order ("reveal:" prefix for the latter). */
  opened(): Promise<string[]>
  close(): Promise<void>
}

export interface LaunchOptions {
  /** Ollama to use; omit for the real one on 127.0.0.1:11434. */
  ollamaUrl?: string
  /** A packaged Recall.exe instead of the built app in out/. Defaults to RECALL_E2E_EXE, so the whole suite can run packaged. */
  executablePath?: string
  /** Start again on the data folder and corpus of an earlier run. */
  reuse?: { dataDir: string; corpus: string }
  args?: string[]
  env?: Record<string, string>
}

/**
 * Launches the app with a fresh data folder, its own Electron profile and a copy of the fixture corpus.
 * The folder picker and file opening are replaced in the main process (plan doc 07 §2),
 * so no native dialog appears and no file is launched.
 */
export async function launchRecall(name: string, opts: LaunchOptions = {}): Promise<RecallRun> {
  const base = path.join(ROOT, 'tests', '.tmp', 'e2e', `${name}-${Date.now()}`)
  const corpus = opts.reuse?.corpus ?? path.join(base, 'corpus')
  if (!opts.reuse) cpSync(path.join(ROOT, 'tests', 'fixtures', 'corpus'), corpus, { recursive: true, preserveTimestamps: true })
  const dataDir = opts.reuse?.dataDir ?? path.join(base, 'data')
  const executablePath = opts.executablePath ?? (process.env.RECALL_E2E_EXE ? path.resolve(ROOT, process.env.RECALL_E2E_EXE) : undefined)

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE // set in some shells; it would start Electron as plain Node
  delete env.ELECTRON_RENDERER_URL // always test the built renderer, never a dev server
  delete env.RECALL_NETWORK_AUDIT
  Object.assign(env, { RECALL_E2E: '1', RECALL_DATA_DIR: dataDir }, opts.env)
  if (opts.ollamaUrl) env.RECALL_OLLAMA_URL = opts.ollamaUrl
  else delete env.RECALL_OLLAMA_URL

  const app = await electron.launch({
    executablePath,
    args: [...(executablePath ? [] : [ROOT]), ...(opts.args ?? [])],
    cwd: ROOT,
    env
  })
  await app.evaluate(({ dialog, shell }, folder) => {
    const g = globalThis as unknown as { __opened: string[] }
    g.__opened = []
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog
    shell.openPath = async (p: string) => {
      g.__opened.push(p)
      return ''
    }
    shell.showItemInFolder = (p: string) => {
      g.__opened.push('reveal:' + p)
    }
  }, corpus)
  const page = await app.firstWindow()
  return {
    app,
    page,
    dataDir,
    corpus,
    opened: () => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened),
    close: () => app.close()
  }
}

export function getStatus(page: Page): Promise<AppStatus> {
  return page.evaluate(() => window.recall.getStatus())
}

/** Waits until every file is read and, when local AI is ready, every passage is embedded. */
export async function waitForIndexed(page: Page): Promise<AppStatus> {
  let last: AppStatus | undefined
  await expect
    .poll(
      async () => {
        last = await getStatus(page)
        const p = last.progress
        const embedded = last.ai.state !== 'ready' || p.embedDone === p.embedTotal
        return !p.scanning && p.filesPending === 0 && p.readTotal > 0 && p.readDone === p.readTotal && embedded
      },
      { timeout: 90_000, intervals: [300] }
    )
    .toBe(true)
  return last!
}

/**
 * Moves focus with Tab until the focused element's text or accessible label matches `name`, proving it is
 * reachable by keyboard. Fails after 40 presses.
 */
export async function tabTo(page: Page, name: string | RegExp): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab')
    const label = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      return (el?.getAttribute('aria-label') || el?.textContent || '').trim()
    })
    if (typeof name === 'string' ? label.startsWith(name) : name.test(label)) return
  }
  throw new Error(`"${name}" was not reachable with Tab`)
}

/** axe-core scan of the current screen; serious and critical violations fail the test (plan doc 07 §9). */
export async function expectAccessible(page: Page, screen: string): Promise<void> {
  if (!(await page.evaluate(() => 'axe' in window))) await page.evaluate(AXE_SOURCE)
  const violations = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run(ctx: Document, opts: object): Promise<{ violations: AxeViolation[] }> } }).axe
    const res = await axe.run(document, { resultTypes: ['violations'] })
    return res.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }))
  })
  for (const v of violations.filter((x) => x.impact !== 'serious' && x.impact !== 'critical')) {
    test.info().annotations.push({ type: `axe ${v.impact} (${screen})`, description: `${v.id}: ${v.help} — ${v.targets.join(', ')}` })
  }
  expect(violations.filter((x) => x.impact === 'serious' || x.impact === 'critical'), `accessibility on ${screen}`).toEqual([])
}

interface AxeViolation {
  id: string
  impact: string | null
  help: string
  nodes: { target: string[] }[]
}

/** Process id of the engine (Electron utility process "Recall Engine"), or undefined while it is down. */
export async function enginePid(app: ElectronApplication): Promise<number | undefined> {
  // The utility process's `name` is the serviceName it was forked with.
  const metrics = await app.evaluate(({ app }) => app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, name: m.name })))
  return metrics.find((m) => m.type === 'Utility' && m.name === 'Recall Engine')?.pid
}
