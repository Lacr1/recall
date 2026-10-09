import { appendFileSync } from 'node:fs'
import dgram from 'node:dgram'
import dns from 'node:dns'
import net from 'node:net'

// Recall's own processes may only talk to this computer (plan doc 06 §8, ADR-0013). This guard sits below every
// Node networking API (fetch, http, https, net, tls, dns, dgram), so a new dependency cannot open a connection by
// accident. Blocked attempts fail with ERR_RECALL_NETWORK_BLOCKED.
// With RECALL_NETWORK_AUDIT=<file>, every attempt, allowed or blocked, is appended to that file as a JSON line
// (used by `npm run audit:network`).

const AUDIT_FILE = process.env.RECALL_NETWORK_AUDIT

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1' || /^(::ffff:)?127\.\d+\.\d+\.\d+$/.test(h)
}

export function installNetworkGuard(processName: string): void {
  const record = (kind: string, target: string, allowed: boolean) => {
    if (!AUDIT_FILE) return
    try {
      appendFileSync(AUDIT_FILE, JSON.stringify({ t: Date.now(), process: processName, kind, target, allowed }) + '\n')
    } catch {
      // Auditing must never break the app.
    }
  }
  const blocked = (target: string) =>
    Object.assign(new Error(`Recall blocks network access outside this computer (${target})`), { code: 'ERR_RECALL_NETWORK_BLOCKED' })

  // TCP and TLS: every client connection, including fetch (undici), goes through Socket#connect.
  const connect = net.Socket.prototype.connect as (this: net.Socket, ...args: unknown[]) => net.Socket
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0]
    let host: string | undefined
    let port: unknown
    if (typeof first === 'object' && first !== null) {
      const o = first as { host?: string; port?: unknown; path?: string | null }
      // Same rule as Node: a non-empty path means a pipe. HTTP passes path: null for TCP.
      if (!o.path) {
        host = o.host ?? 'localhost'
        port = o.port
      }
    } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
      port = first
      host = typeof args[1] === 'string' ? args[1] : 'localhost'
    }
    // Named pipes and Unix sockets (a string path) are local by definition.
    if (host !== undefined) {
      const target = `${host}:${String(port)}`
      const ok = isLoopbackHost(host)
      record('tcp', target, ok)
      if (!ok) {
        process.nextTick(() => this.destroy(blocked(target)))
        return this
      }
    }
    return connect.apply(this, args)
  } as typeof net.Socket.prototype.connect

  // DNS: only names that resolve on this computer.
  const guardDns = (api: Record<string, unknown>, promises: boolean) => {
    for (const name of Object.keys(api)) {
      if (!/^(lookup|resolve)/.test(name) || typeof api[name] !== 'function') continue
      const original = api[name] as (...a: unknown[]) => unknown
      api[name] = function (this: unknown, ...a: unknown[]) {
        const host = String(a[0])
        const ok = name === 'lookupService' ? isLoopbackHost(host) : host.toLowerCase() === 'localhost' || isLoopbackHost(host)
        record('dns', host, ok)
        if (ok) return original.apply(this, a)
        if (promises) return Promise.reject(blocked(host))
        const cb = a[a.length - 1]
        if (typeof cb === 'function') process.nextTick(() => (cb as (e: Error) => void)(blocked(host)))
        return undefined
      }
    }
  }
  guardDns(dns as unknown as Record<string, unknown>, false)
  guardDns(dns.promises as unknown as Record<string, unknown>, true)

  // UDP: block sends and connects to anything but loopback (default destination is loopback).
  for (const method of ['send', 'connect'] as const) {
    const original = dgram.Socket.prototype[method] as (...a: unknown[]) => unknown
    dgram.Socket.prototype[method] = function (this: dgram.Socket, ...a: unknown[]) {
      const address = a.slice(method === 'send' ? 1 : 0).find((x): x is string => typeof x === 'string')
      const ok = address === undefined || isLoopbackHost(address)
      record('udp', address ?? 'loopback', ok)
      if (!ok) throw blocked(address!)
      return original.apply(this, a)
    } as never
  }
}
