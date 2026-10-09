import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Request, Response } from 'express'
import { config } from '../config.js'
import { pool } from '../db/client.js'
import { confirmReservation } from '../booking/reservations.js'
import { sendBookingConfirmation } from '../notifications/email.js'
import { log } from '../lib/logger.js'

/**
 * Receives events from the payment provider. Every request is signed: the header "Payment-Signature"
 * has the form "t=<unix time>,v1=<hex hmac>", where the HMAC-SHA256 covers "<t>.<raw body>".
 * We reject old timestamps to stop replay attacks, and store processed event ids so that the
 * provider's retries never confirm or refund a booking twice (see docs/adr/0002-idempotent-webhooks.md).
 */
export async function handlePaymentWebhook(req: Request, res: Response) {
  const raw = req.body as Buffer
  if (!verifySignature(raw, String(req.headers['payment-signature'] ?? ''))) {
    log.warn('payment webhook signature check failed')
    return res.status(401).send('bad signature')
  }
  const event = JSON.parse(raw.toString('utf8'))
  const inserted = await pool.query('INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING', [event.id])
  if (inserted.rowCount === 0) return res.status(200).send('already processed')

  switch (event.type) {
    case 'payment.succeeded':
      await confirmReservation(event.data.reservation_id)
      await sendBookingConfirmation(event.data.reservation_id)
      break
    case 'payment.failed':
      await pool.query("UPDATE reservations SET status = 'payment_failed' WHERE id = $1", [event.data.reservation_id])
      break
    case 'refund.completed':
      await pool.query("UPDATE refunds SET status = 'completed' WHERE provider_refund_id = $1", [event.data.refund_id])
      break
    default:
      log.info('ignored payment event ' + event.type)
  }
  res.status(200).send('ok')
}

export function verifySignature(raw: Buffer, header: string, now = Date.now()): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]))
  const t = Number(parts.t)
  if (!t || Math.abs(now / 1000 - t) > config.payment.webhookToleranceSeconds) return false
  const expected = createHmac('sha256', config.payment.webhookSecret).update(t + '.' + raw.toString('utf8')).digest()
  const given = Buffer.from(parts.v1 ?? '', 'hex')
  return given.length === expected.length && timingSafeEqual(given, expected)
}
