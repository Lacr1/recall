import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { pool } from '../db/client.js'

const scryptAsync = promisify(scrypt)
const RESET_TOKEN_MINUTES = 60

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = (await scryptAsync(password, salt, 64)) as Buffer
  return salt.toString('hex') + ':' + hash.toString('hex')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':')
  const hash = (await scryptAsync(password, Buffer.from(saltHex, 'hex'), 64)) as Buffer
  return timingSafeEqual(hash, Buffer.from(hashHex, 'hex'))
}

/** Creates a one-time password reset link token that expires after an hour. Only the hash is stored. */
export async function createResetToken(userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  const hash = createHash('sha256').update(token).digest('hex')
  await pool.query(
    "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))",
    [userId, hash, RESET_TOKEN_MINUTES]
  )
  return token
}
