import type { Request, Response, NextFunction } from 'express'

interface Bucket {
  tokens: number
  updated: number
}

/**
 * Token bucket per client IP. Each bucket holds perMinute tokens and refills continuously.
 * The login route uses 5 per minute to slow down password guessing.
 */
export function rateLimit({ perMinute }: { perMinute: number }) {
  const buckets = new Map<string, Bucket>()
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now()
    const ip = req.ip ?? 'unknown'
    const b = buckets.get(ip) ?? { tokens: perMinute, updated: now }
    b.tokens = Math.min(perMinute, b.tokens + ((now - b.updated) / 60000) * perMinute)
    b.updated = now
    if (b.tokens < 1) {
      res.setHeader('Retry-After', '60')
      return res.status(429).json({ error: 'Too many requests' })
    }
    b.tokens -= 1
    buckets.set(ip, b)
    next()
  }
}
