import { config } from '../config.js'

/** Thin client for the payment provider's REST API. Every POST carries an idempotency key when one is given. */
async function post(path: string, body: Record<string, unknown>, idempotencyKey?: string) {
  const res = await fetch('https://api.payments.example/v2' + path, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + config.payment.apiKey,
      'content-type': 'application/json',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {})
    },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error('Payment provider error ' + res.status)
  return res.json()
}

export const paymentApi = {
  checkout: { create: (body: Record<string, unknown>) => post('/checkout/sessions', body) },
  refunds: {
    create: ({ idempotencyKey, ...body }: { payment: string; amount: number; idempotencyKey: string }) => post('/refunds', body, idempotencyKey)
  }
}
