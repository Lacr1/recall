import { describe, it, expect } from 'vitest'
import { refundShare } from '../src/booking/cancellations.js'

const departure = new Date('2026-07-10T08:00:00Z')
const daysBefore = (d: number) => new Date(departure.getTime() - d * 86400000)

describe('refundShare', () => {
  it('refunds everything more than a week ahead', () => expect(refundShare(departure, daysBefore(8))).toBe(1))
  it('refunds half between a week and two days', () => expect(refundShare(departure, daysBefore(3))).toBe(0.5))
  it('refunds nothing in the last 48 hours', () => expect(refundShare(departure, daysBefore(1))).toBe(0))
  it('always refunds operator cancellations', () => expect(refundShare(departure, daysBefore(0), true)).toBe(1))
})
