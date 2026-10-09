import { describe, it, expect } from 'vitest'
import { holdSeats } from '../src/booking/reservations.js'
import { seedDeparture, seedCustomer } from './helpers.js'

describe('holdSeats', () => {
  it('lets only one of two parallel checkouts take the last seat', async () => {
    const departure = await seedDeparture({ capacity: 1 })
    const [a, b] = await Promise.all([seedCustomer(), seedCustomer()])
    const results = await Promise.allSettled([holdSeats(departure, a, 1), holdSeats(departure, b, 1)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  })

  it('rejects groups larger than 12', async () => {
    const departure = await seedDeparture({ capacity: 20 })
    await expect(holdSeats(departure, await seedCustomer(), 13)).rejects.toThrow('1 to 12 people')
  })
})
