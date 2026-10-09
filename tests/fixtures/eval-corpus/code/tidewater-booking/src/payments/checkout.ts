import { pool } from '../db/client.js'
import { paymentApi } from './provider.js'

/** Creates a hosted checkout page for a held reservation. Amounts are always integer cents in EUR. */
export async function createCheckoutSession(reservationId: string) {
  const { rows } = await pool.query(
    "SELECT id, price_cents, customer_id FROM reservations WHERE id = $1 AND status = 'held'",
    [reservationId]
  )
  if (!rows[0]) throw new Error('Reservation is not held any more; the 10 minute hold may have expired')
  const session = await paymentApi.checkout.create({
    amount: rows[0].price_cents,
    currency: 'EUR',
    metadata: { reservation_id: reservationId },
    successUrl: 'https://book.tidewaterlabs.se/done',
    cancelUrl: 'https://book.tidewaterlabs.se/cancelled'
  })
  await pool.query('UPDATE reservations SET payment_id = $2 WHERE id = $1', [reservationId, session.paymentId])
  return { url: session.url }
}
