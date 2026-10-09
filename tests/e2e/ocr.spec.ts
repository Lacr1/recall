import { expect, test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { CHAT_MODEL, EMBED_MODEL } from '../../src/shared/constants'
import { FakeOllama } from '../support/fake-ollama'
import { CHOOSE_FOLDER, expectAccessible, launchRecall, resultOptions, waitForIndexed, type RecallRun } from './recall'

// S4-06: OCR is off by default; turned on in Settings, text in images becomes searchable. Run against the
// packaged Recall.exe too (RECALL_E2E_EXE), where tesseract loads its worker and data outside the asar.
test.describe.configure({ mode: 'serial' })

// Playwright loads specs as CommonJS, so plain require works here.
const { createCanvas } = require('@napi-rs/canvas') as typeof import('@napi-rs/canvas')

let run: RecallRun
const ollama = new FakeOllama({ models: [EMBED_MODEL, CHAT_MODEL] })

test.beforeAll(async () => {
  await ollama.start()
  run = await launchRecall('ai', { ollamaUrl: ollama.url })
  const canvas = createCanvas(1000, 320)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#111111'
  ctx.font = '44px Arial'
  ;['Harbour Kayak Rentals', 'Two person kayak, 3 hours', 'Total paid 84.50 EUR'].forEach((l, i) => ctx.fillText(l, 50, 90 + i * 70))
  mkdirSync(path.join(run.corpus, 'receipts'), { recursive: true })
  writeFileSync(path.join(run.corpus, 'receipts', 'IMG_2041.png'), canvas.toBuffer('image/png'))
})

test.afterAll(async () => {
  await run?.close()
  await ollama.stop()
})

test('reads text in images once OCR is turned on', async () => {
  const { page } = run
  await page.getByRole('button', { name: 'Get started' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: CHOOSE_FOLDER }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Start searching' }).click()
  await waitForIndexed(page)

  await page.getByRole('searchbox').fill('harbour kayak rentals')
  await expect(page.locator('.results-meta')).toContainText('file')
  await expect(resultOptions(page).filter({ hasText: 'IMG_2041.png' })).toHaveCount(0)

  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('button', { name: 'Settings' }).click()
  const ocr = page.getByRole('checkbox', { name: 'Read text in images and scanned PDFs (OCR)' })
  await expect(ocr).not.toBeChecked()
  await ocr.check()
  await expect(ocr).toBeChecked()
  await expectAccessible(page, 'settings: OCR on')

  await nav.getByRole('button', { name: 'Search' }).click()
  await page.getByRole('searchbox').fill('harbour kayak rentals')
  await expect(resultOptions(page).filter({ hasText: 'IMG_2041.png' })).toBeVisible({ timeout: 60_000 })
  await expect(resultOptions(page).filter({ hasText: 'IMG_2041.png' })).toContainText('IMG')

  await nav.getByRole('button', { name: 'Settings' }).click()
  await ocr.uncheck()
  await nav.getByRole('button', { name: 'Search' }).click()
  await page.getByRole('searchbox').fill('harbour kayak rentals')
  await expect(resultOptions(page).filter({ hasText: 'IMG_2041.png' })).toHaveCount(0, { timeout: 30_000 })
})
