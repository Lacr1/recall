import type { Request, Response, NextFunction } from 'express'
import { verifyAccessToken } from './tokens.js'
import { pool } from '../db/client.js'

/** Rejects requests without a valid Bearer access token and attaches the user to the request. */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token) return res.status(401).json({ error: 'Not signed in' })
  try {
    const userId = await verifyAccessToken(token)
    const { rows } = await pool.query('SELECT id, role FROM users WHERE id = $1 AND disabled = false', [userId])
    if (!rows[0]) return res.status(401).json({ error: 'Account disabled' })
    req.user = rows[0]
    next()
  } catch {
    // Expired access tokens land here; the client should call /auth/refresh and retry.
    res.status(401).json({ error: 'Token expired' })
  }
}

export function requireRole(role: 'admin' | 'guide') {
  return (req: Request, res: Response, next: NextFunction) =>
    req.user?.role === role ? next() : res.status(403).json({ error: 'Forbidden' })
}
