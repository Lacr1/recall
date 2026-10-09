import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import dgram from 'node:dgram'
import dns from 'node:dns'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// The guard patches Node's networking for the whole process, as it does in main and the engine.
// TEST-NET addresses (RFC 5737) and .invalid names never route, so nothing leaves the machine even on failure.
const TMP_ROOT = path.resolve('tests/.tmp')
let dir: string
let auditFile: string
let isLoopbackHost: (h: string) => boolean

beforeAll(async () => {
  mkdirSync(TMP_ROOT, { recursive: true })
  dir = mkdtempSync(path.join(TMP_ROOT, 'guard-'))
  auditFile = path.join(dir, 'audit.jsonl')
  vi.stubEnv('RECALL_NETWORK_AUDIT', auditFile)
  const guard = await import('../../src/engine/network-guard')
  guard.installNetworkGuard('test')
  isLoopbackHost = guard.isLoopbackHost
})

afterAll(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const errorOf = (start: (done: (err?: NodeJS.ErrnoException) => void) => void) =>
  new Promise<NodeJS.ErrnoException | undefined>((resolve) => start(resolve))

describe('network guard', () => {
  it('recognises loopback hosts only', () => {
    for (const h of ['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '::ffff:127.0.0.1']) expect(isLoopbackHost(h), h).toBe(true)
    for (const h of ['example.com', '10.0.0.1', '192.0.2.1', '0.0.0.0', '::ffff:8.8.8.8', 'localhost.example.com']) expect(isLoopbackHost(h), h).toBe(false)
  })

  it('blocks TCP, HTTP and TLS connections to other machines', async () => {
    const tcp = await errorOf((done) => net.connect({ host: '192.0.2.1', port: 80 }).on('error', done).on('connect', () => done()))
    expect(tcp?.code).toBe('ERR_RECALL_NETWORK_BLOCKED')
    const byPort = await errorOf((done) => net.connect(443, 'example.invalid').on('error', done).on('connect', () => done()))
    expect(byPort?.code).toBe('ERR_RECALL_NETWORK_BLOCKED')
    const web = await errorOf((done) => http.get('http://198.51.100.7/', () => done()).on('error', done))
    expect(web?.code).toBe('ERR_RECALL_NETWORK_BLOCKED')
  })

  it('blocks DNS lookups of other machines', async () => {
    const lookup = await errorOf((done) => dns.lookup('example.invalid', (err) => done(err ?? undefined)))
    expect(lookup?.code).toBe('ERR_RECALL_NETWORK_BLOCKED')
    await expect(dns.promises.resolve4('example.invalid')).rejects.toMatchObject({ code: 'ERR_RECALL_NETWORK_BLOCKED' })
  })

  it('blocks UDP to other machines', () => {
    const socket = dgram.createSocket('udp4')
    expect(() => socket.send('x', 53, '192.0.2.53')).toThrow(/blocks network access/)
    socket.close()
  })

  it('allows connections to this computer', async () => {
    const server = http.createServer((_req, res) => res.end('ok'))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const { port } = server.address() as AddressInfo
    const body = await new Promise<string>((resolve, reject) =>
      http.get(`http://localhost:${port}/`, (res) => {
        let b = ''
        res.on('data', (d) => (b += d)).on('end', () => resolve(b))
      }).on('error', reject)
    )
    expect(body).toBe('ok')
    // fetch (undici, used for Ollama) goes through the same hook.
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('ok')
    server.close()
  })

  it('records every attempt in the audit file', () => {
    const lines = readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; target: string; allowed: boolean })
    expect(lines).toContainEqual(expect.objectContaining({ kind: 'tcp', target: '192.0.2.1:80', allowed: false }))
    expect(lines).toContainEqual(expect.objectContaining({ kind: 'dns', target: 'example.invalid', allowed: false }))
    expect(lines).toContainEqual(expect.objectContaining({ kind: 'udp', target: '192.0.2.53', allowed: false }))
    expect(lines.some((l) => l.kind === 'tcp' && l.target.startsWith('localhost:') && l.allowed)).toBe(true)
    expect(lines.some((l) => l.kind === 'tcp' && l.target.startsWith('127.0.0.1:') && l.allowed)).toBe(true)
  })
})
