import { expect, test } from '@playwright/test'
import { closeSync, openSync, rmSync, statSync, writeSync } from 'node:fs'
import path from 'node:path'
import { assertIndexConsistent, openDatabase } from '../../src/engine/db'
import { FakeOllama } from '../support/fake-ollama'
import { CHOOSE_FOLDER, enginePid, expectAccessible, getStatus, launchRecall, waitForIndexed, type RecallRun } from './recall'

// S3-04 recovery in the real app (plan doc 02 §5.13): the engine crashing while it indexes, the supervisor giving
// up after repeated crashes, and a damaged index found on the next start. Run with RECALL_E2E_EXE set to cover the
// packaged app.
test.describe.configure({ mode: 'serial' })

let run: RecallRun
const ollama = new FakeOllama()

test.beforeAll(async () => {
  await ollama.start()
  run = await launchRecall('recovery', { ollamaUrl: ollama.url })
})

test.afterAll(async () => {
  await run?.close().catch(() => undefined)
  await ollama.stop()
})

async function killEngine(): Promise<void> {
  const pid = await enginePid(run.app)
  expect(pid, 'engine should be running').toBeDefined()
  process.kill(pid!) // terminates at once on Windows, like a crash
  await expect.poll(() => enginePid(run.app)).not.toBe(pid)
}

test('the engine is killed three times while indexing: it restarts and the index stays consistent', async () => {
  const { page } = run
  await page.getByRole('button', { name: 'Get started' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: CHOOSE_FOLDER }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  // Voice step: left off.
  await expect(page.getByRole('heading', { name: 'Talk to Recall' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Start searching' }).click()

  for (const delay of [150, 400, 700]) {
    await page.waitForTimeout(delay)
    await killEngine()
    await expect(page.getByRole('status').filter({ hasText: 'Recall’s indexer restarted after a problem' })).toBeVisible()
    await page.getByRole('button', { name: 'Dismiss' }).first().click()
  }

  await waitForIndexed(page)
  await page.getByRole('searchbox').fill('dishwasher warranty period')
  await expect(page.getByRole('option').filter({ hasText: 'Dishwasher_DW-450_Manual.pdf' })).toBeVisible()
})

test('after a fourth crash it stops restarting and offers "Restart indexer"', async () => {
  const { page } = run
  await killEngine()
  const banner = page.getByRole('alert').filter({ hasText: 'Recall’s indexer stopped' })
  await expect(banner).toBeVisible({ timeout: 20_000 })
  await expectAccessible(page, 'engine stopped banner')
  await banner.getByRole('button', { name: 'Restart indexer' }).click()
  await expect.poll(() => enginePid(run.app)).toBeDefined()
  await expect(page.getByRole('searchbox')).toBeVisible()
  await page.getByRole('searchbox').fill('dishwasher warranty period')
  await expect(page.getByRole('option').filter({ hasText: 'Dishwasher_DW-450_Manual.pdf' })).toBeVisible()
})

test('a damaged index is found on the next start and rebuilt from the same folders', async () => {
  const { dataDir, corpus } = run
  await run.close()

  // The index left behind by all those crashes is consistent.
  const file = path.join(dataDir, 'recall.db')
  const db = openDatabase(file)
  assertIndexConsistent(db)
  db.close()

  // Damage the middle of the file, as a failing disk might, and make the next start check it.
  const pages = statSync(file).size / 4096
  const fd = openSync(file, 'r+')
  writeSync(fd, Buffer.alloc(4096 * 4, 0xa5), 0, 4096 * 4, 4096 * Math.floor(pages / 2))
  closeSync(fd)
  rmSync(path.join(dataDir, 'clean-shutdown'), { force: true })

  run = await launchRecall('recovery', { ollamaUrl: ollama.url, reuse: { dataDir, corpus } })
  const { page } = run
  await expect(page.getByRole('heading', { name: 'Recall’s index is damaged' })).toBeVisible()
  await expect(page.getByText('Your files are safe')).toBeVisible()
  await expectAccessible(page, 'damaged index screen')
  await page.getByRole('button', { name: 'Rebuild index' }).click()

  await expect(page.getByRole('status').filter({ hasText: 'Recall rebuilt its index from your folders' })).toBeVisible()
  const status = await waitForIndexed(page)
  expect(status.folders.map((f) => f.path)).toEqual([corpus])
  await page.getByRole('searchbox').fill('dishwasher warranty period')
  await expect(page.getByRole('option').filter({ hasText: 'Dishwasher_DW-450_Manual.pdf' })).toBeVisible()
  expect((await getStatus(page)).problem).toBeUndefined()
})
