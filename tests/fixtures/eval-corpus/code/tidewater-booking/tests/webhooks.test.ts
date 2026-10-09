import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifySignature } from '../src/payments/webhooks.js'

const secret = process.env.PAYMENT_WEBHOOK_SECRET ?? 'test-secret'
const sign = (body: string, t: number) => 't=' + t + ',v1=' + createHmac('sha256', secret).update(t + '.' + body).digest('hex')

describe('verifySignature', () => {
  const body = '{"id":"evt_1","type":"payment.succeeded"}'
  it('accepts a fresh, correct signature', () => {
    const t = Math.floor(Date.now() / 1000)
    expect(verifySignature(Buffer.from(body), sign(body, t))).toBe(true)
  })
  it('rejects a replayed request older than five minutes', () => {
    const t = Math.floor(Date.now() / 1000) - 600
    expect(verifySignature(Buffer.from(body), sign(body, t))).toBe(false)
  })
})
