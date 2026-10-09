import type { Request, Response } from 'express'
import { pool } from '../db/client.js'
import { verifyPassword } from './password.js'
import { issueTokens, refreshAccessToken, AuthError } from './tokens.js'

/** POST /auth/login: email and password in, token pair out. Same error for unknown email and wrong password. */
export async function login(req: Request, res: Response) {
  const { email, password } = req.body ?? {}
  const { rows } = await pool.query('SELECT id, password_hash FROM users WHERE email = $1 AND disabled = false', [String(email).toLowerCase()])
  if (!rows[0] || !(await verifyPassword(String(password), rows[0].password_hash))) {
    return res.status(401).json({ error: 'Wrong email or password' })
  }
  res.json(await issueTokens(rows[0].id))
}

/** POST /auth/refresh: the admin app calls this when an API call fails with "Token expired". */
export async function refresh(req: Request, res: Response) {
  try {
    res.json(await refreshAccessToken(String(req.body?.refreshToken ?? '')))
  } catch (err) {
    if (err instanceof AuthError) return res.status(401).json({ error: err.message })
    throw err
  }
}
