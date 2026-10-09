// Applies SQL files in migrations/ in order and records each one in schema_migrations.
import { readdirSync, readFileSync } from 'node:fs'
import pg from 'pg'

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())')
const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name))

for (const name of readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort()) {
  if (done.has(name)) continue
  const sql = readFileSync('migrations/' + name, 'utf8')
  // CREATE INDEX CONCURRENTLY cannot run inside a transaction.
  const tx = !sql.includes('CONCURRENTLY')
  if (tx) await client.query('BEGIN')
  await client.query(sql)
  await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name])
  if (tx) await client.query('COMMIT')
  console.log('applied ' + name)
}
await client.end()
