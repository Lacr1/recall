import { pool } from '../db/client.js'
import { paymentApi } from './provider.js'
import { withRetry } from '../lib/retry.js'

/**
 * Refunds part or all of a payment. Refunds are sent to the provider immediately (they used to be
 * batched nightly, which made customers wait up to a week). Provider fees are not returned.
 */
export async function issueRefund(paymentId: string, amountCents: number, reason: string) {
  if (amountCents <= 0) return null
  const { rows } = await pool.query(
    "INSERT INTO refunds (payment_id, amount_cents, reason, status) VALUES ($1, $2, $3, 'requested') RETURNING id",
    [paymentId, amountCents, reason]
  )
  const refundId = rows[0].id
  const result = await withRetry(() => paymentApi.refunds.create({ payment: paymentId, amount: amountCents, idempotencyKey: 'refund-' + refundId }), { attempts: 4 })
  await pool.query('UPDATE refunds SET provider_refund_id = $2 WHERE id = $1', [refundId, result.id])
  return refundId
}
