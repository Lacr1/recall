import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

interface Config {
  port: number
  databaseUrl: string
  jwtSecret: string
  payment: { apiKey: string; webhookSecret: string; webhookToleranceSeconds: number }
  smtp: { host: string; port: number; from: string }
  sms: { provider: string; sender: string }
}

const env = process.env.APP_ENV ?? 'local'
const file = parse(readFileSync('config/' + env + '.yaml', 'utf8'))

// Secrets come from the environment (injected by the secrets manager), never from the YAML files.
export const config: Config = {
  port: file.port ?? 4010,
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  payment: {
    apiKey: required('PAYMENT_API_KEY'),
    webhookSecret: required('PAYMENT_WEBHOOK_SECRET'),
    webhookToleranceSeconds: file.payment?.webhookToleranceSeconds ?? 300
  },
  smtp: file.smtp,
  sms: file.sms
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error('Missing environment variable ' + name)
  return value
}
