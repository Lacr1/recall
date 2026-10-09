import { randomBytes, timingSafeEqual } from 'node:crypto'
import { db } from '../db'

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14

// Creates a login session after the password has been verified.
export async function createSession(userId: string) {
  const token = randomBytes(32).toString('hex')
  await db.sessions.insert({ userId, token, expiresAt: Date.now() + SESSION_TTL_MS })
  return token
}

// Validates the session cookie on each request and slides the expiry window.
export async function authenticate(token: string) {
  const session = await db.sessions.findByToken(token)
  if (!session || session.expiresAt < Date.now()) return null
  if (!timingSafeEqual(Buffer.from(session.token), Buffer.from(token))) return null
  await db.sessions.update(session.id, { expiresAt: Date.now() + SESSION_TTL_MS })
  return session.userId
}

export async function logout(token: string) {
  await db.sessions.deleteByToken(token)
}
