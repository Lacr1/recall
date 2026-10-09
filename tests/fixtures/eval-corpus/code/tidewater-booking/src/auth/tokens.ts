import { randomBytes, createHash } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import { pool } from '../db/client.js'
import { config } from '../config.js'

const ACCESS_TTL_SECONDS = 15 * 60
const REFRESH_TTL_DAYS = 30
const key = new TextEncoder().encode(config.jwtSecret)

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** Issues a short-lived access token and a long-lived refresh token after login. */
export async function issueTokens(userId: string, familyId = randomBytes(16).toString('hex')) {
  const accessToken = await new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(Math.floor(Date.now() / 1000) + ACCESS_TTL_SECONDS)
    .sign(key)
  const refreshToken = randomBytes(32).toString('base64url')
  await pool.query(
    "INSERT INTO refresh_tokens (token_hash, user_id, family_id, expires_at) VALUES ($1, $2, $3, now() + interval '30 days')",
    [sha256(refreshToken), userId, familyId]
  )
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS }
}

/**
 * Exchanges a refresh token for a new pair. Refresh tokens rotate: each one can be used once.
 * If an already-used token is presented again, someone may have stolen it, so the whole family
 * (every token issued from the same login) is revoked and the user has to sign in again.
 */
export async function refreshAccessToken(refreshToken: string) {
  const { rows } = await pool.query('SELECT * FROM refresh_tokens WHERE token_hash = $1', [sha256(refreshToken)])
  const row = rows[0]
  if (!row || row.expires_at < new Date()) throw new AuthError('Refresh token expired or unknown')
  if (row.used_at) {
    await pool.query('UPDATE refresh_tokens SET revoked = true WHERE family_id = $1', [row.family_id])
    throw new AuthError('Refresh token reuse detected; session revoked')
  }
  if (row.revoked) throw new AuthError('Session revoked')
  await pool.query('UPDATE refresh_tokens SET used_at = now() WHERE token_hash = $1', [row.token_hash])
  return issueTokens(row.user_id, row.family_id)
}

export async function verifyAccessToken(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, key)
  return String(payload.sub)
}

export async function revokeAllSessions(userId: string) {
  await pool.query('UPDATE refresh_tokens SET revoked = true WHERE user_id = $1', [userId])
}

export class AuthError extends Error {}
