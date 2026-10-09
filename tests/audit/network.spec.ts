import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { CHOOSE_FOLDER, launchRecall, resultOptions, waitForIndexed, type RecallRun } from '../e2e/recall'

// S3-07 automated network audit (plan doc 07 §8): drive the whole app with the real Ollama and record every network
// attempt three ways — Recall's own guard (Node, main + engine), Chromium's net log (renderer, network service)
// and Windows' TCP table for the whole process tree. Anything that leaves this computer fails the run.
// RECALL_AUDIT_EXE=dist/win-unpacked/Recall.exe audits the packaged app instead of the build in out/.

const ROOT = path.resolve(__dirname, '../..')
const OUT = path.join(ROOT, 'tests', '.tmp', 'audit', String(Date.now()))
const GUARD_LOG = path.join(OUT, 'guard.jsonl')
const NET_LOG = path.join(OUT, 'netlog.json')
const TCP_LOG = path.join(OUT, 'tcp.txt')
const STOP = path.join(OUT, 'stop')
const REPORT = path.join(ROOT, 'eval-results', 'network-audit.md')
const EXE = process.env.RECALL_AUDIT_EXE ? path.resolve(ROOT, process.env.RECALL_AUDIT_EXE) : undefined

const QUERIES = (JSON.parse(readFileSync(path.join(ROOT, 'tests', 'eval', 'queries.json'), 'utf8')) as { query: string }[])
  .slice(0, 20)
  .map((q) => q.query)

const isLoopback = (host: string) => /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\]|::ffff:127\.\d+\.\d+\.\d+)$/i.test(host)
const LOCAL_SCHEMES = new Set(['file:', 'data:', 'devtools:', 'chrome:', 'about:', 'blob:', 'chrome-extension:'])

test.describe.configure({ mode: 'serial' })
let run: RecallRun
let askRan = false

test('audit: whole app flow with real Ollama', async () => {
  test.setTimeout(10 * 60_000)
  const tags = await fetch('http://127.0.0.1:11434/api/tags').then((r) => r.json() as Promise<{ models: { name: string }[] }>).catch(() => undefined)
  expect(tags, 'Ollama must be running on 127.0.0.1:11434').toBeTruthy()
  expect(tags!.models.map((m) => m.name)).toEqual(expect.arrayContaining(['nomic-embed-text:latest']))

  mkdirSync(OUT, { recursive: true })
  run = await launchRecall('audit', {
    executablePath: EXE,
    args: [`--log-net-log=${NET_LOG}`],
    env: { RECALL_NETWORK_AUDIT: GUARD_LOG }
  })
  const watcher = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'watch-connections.ps1'),
    '-RootPid', String(run.app.process().pid), '-Out', TCP_LOG, '-StopFile', STOP], { stdio: 'ignore' })
  const { page } = run

  // Onboarding with models present → add the fixture folder → index.
  await page.getByRole('button', { name: 'Get started' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: CHOOSE_FOLDER }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  // Voice step: left off.
  await expect(page.getByRole('heading', { name: 'Talk to Recall' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Start searching' }).click()
  const status = await waitForIndexed(page)
  expect(status.ai.state).toBe('ready')

  // 20 searches by meaning and keywords.
  for (const q of QUERIES) {
    await page.getByRole('searchbox').fill(q)
    await expect(page.locator('.results-meta')).toContainText('meaning + keywords')
  }
  // Details, open, show in folder.
  await page.getByRole('searchbox').fill('dishwasher warranty period')
  await resultOptions(page).first().click()
  const evidence = page.getByRole('complementary', { name: 'Evidence' })
  await evidence.getByRole('button', { name: 'Details', exact: true }).click()
  await page.keyboard.press('Escape')
  await evidence.getByRole('button', { name: 'Open' }).click()
  await evidence.getByRole('button', { name: 'Show in folder' }).click()

  // Ask, if the answer model is installed.
  if (status.ai.chatAvailable) {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Ask' }).click()
    await page.getByRole('textbox', { name: 'Ask a question about your files' }).fill('What payment terms did I propose to Acme?')
    await page.locator('.ask-form').getByRole('button', { name: 'Ask' }).click()
    await expect(page.locator('.disclaimer, .insufficient').first()).toBeVisible({ timeout: 180_000 })
    askRan = true
  }

  // Remove the folder, then delete all data.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Folders' }).click()
  await page.getByRole('button', { name: 'Remove from Recall…' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove from Recall' }).click()
  await expect(page.getByText('No folders yet.')).toBeVisible()
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Delete all Recall data…' }).click()
  await page.getByRole('textbox', { name: 'Type DELETE to confirm' }).fill('DELETE')
  await page.getByRole('button', { name: 'Delete everything' }).click()
  await expect(page.getByRole('button', { name: 'Get started' })).toBeVisible()

  // Let background work settle, then close so Chromium finishes its net log.
  await page.waitForTimeout(3000)
  writeFileSync(STOP, '')
  await new Promise((r) => watcher.once('exit', r))
  await run.close()
})

test('audit: nothing left this computer', () => {
  // 1. Recall's guard in main and the engine.
  const guard = existsSync(GUARD_LOG)
    ? readFileSync(GUARD_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { process: string; kind: string; target: string; allowed: boolean })
    : []
  const guardTargets = countBy(guard.map((g) => `${g.process} ${g.kind} ${g.target.replace(/:\d+$/, (p) => (p === ':11434' ? p : ':<port>'))}${g.allowed ? '' : ' BLOCKED'}`))

  // 2. Chromium's net log: every URL requested and every host resolved or connected to.
  const netlog = JSON.parse(readFileSync(NET_LOG, 'utf8')) as {
    constants: { logEventTypes: Record<string, number> }
    events: { type: number; params?: Record<string, unknown> }[]
  }
  const eventName = Object.fromEntries(Object.entries(netlog.constants.logEventTypes).map(([k, v]) => [v, k]))
  const schemes = new Map<string, number>()
  const remote: string[] = []
  const visit = (key: string, value: unknown) => {
    if (typeof value === 'string') {
      if (key === 'url' || key === 'original_url' || key === 'location' || key === 'origin') {
        let u: URL
        try {
          u = new URL(value)
        } catch {
          return
        }
        schemes.set(u.protocol, (schemes.get(u.protocol) ?? 0) + 1)
        if (!LOCAL_SCHEMES.has(u.protocol) && !isLoopback(u.hostname)) remote.push(`${key}: ${value}`)
      } else if (key === 'host' || key === 'address' || key === 'remote_address' || key === 'proxy_server') {
        const host = value.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
        if (host && !isLoopback(host)) remote.push(`${key}: ${value}`)
      }
    } else if (Array.isArray(value)) value.forEach((v) => visit(key, v))
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(k, v)
  }
  // *_LOCAL_ADDRESS events report this machine's own address, not a destination.
  for (const e of netlog.events) if (e.params && !/LOCAL_ADDRESS/.test(eventName[e.type] ?? '')) visit('', e.params)
  const eventTypes = countBy(netlog.events.map((e) => eventName[e.type] ?? String(e.type)))

  // 3. Windows' TCP table for the whole process tree.
  const tcp = readFileSync(TCP_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.trim().split(' '))
  const tcpRemote = tcp.filter(([, addr]) => !isLoopback(addr))

  const lines = [
    `# Network audit — ${new Date().toISOString()}`,
    '',
    `App: ${EXE ?? 'built app in out/ (development Electron)'}`,
    `Flow: onboarding → add fixture folder → index (real Ollama) → ${QUERIES.length} searches → details/open/reveal → ${askRan ? 'Ask (answered)' : 'Ask skipped: answer model not installed'} → remove folder → delete all data`,
    '',
    '## 1. Recall guard (Node: main + engine)',
    `${guard.length} connection attempts; ${guard.filter((g) => !g.allowed).length} blocked.`,
    '',
    ...[...guardTargets].map(([k, n]) => `- ${k} × ${n}`),
    '',
    '## 2. Chromium net log',
    `${netlog.events.length} events. URL schemes: ${[...schemes].map(([s, n]) => `${s} ${n}`).join(', ') || 'none'}.`,
    `Event types: ${[...eventTypes].map(([t, n]) => `${t} ${n}`).join(', ')}.`,
    `Remote hosts or URLs: ${remote.length ? '' : 'none'}`,
    ...[...new Set(remote)].map((r) => `- ${r}`),
    '',
    '## 3. Windows TCP table (process tree, polled)',
    `${tcp.length} distinct connections; ${tcpRemote.length} to other machines.`,
    ...tcp.map(([pid, addr, port]) => `- pid ${pid} → ${addr}:${port}`)
  ]
  mkdirSync(path.dirname(REPORT), { recursive: true })
  writeFileSync(REPORT, lines.join('\n') + '\n')
  console.log(lines.join('\n'))

  expect(guard.length, 'the guard log should show the engine talking to Ollama').toBeGreaterThan(0)
  expect(guard.filter((g) => !g.allowed)).toEqual([])
  expect([...new Set(remote)]).toEqual([])
  expect(tcpRemote).toEqual([])
})

function countBy(items: string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1)
  return new Map([...m].sort())
}
