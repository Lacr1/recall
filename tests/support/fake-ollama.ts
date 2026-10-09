import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { CHAT_MODEL, EMBED_MODEL } from '../../src/shared/constants'
import { fakeEmbed } from './fake-embeddings'

export interface FakeOllamaOptions {
  /** Models reported by /api/tags. Defaults to the search and answer models. */
  models?: string[]
  /** Text streamed by /api/chat, split into small tokens. */
  chatAnswer?: (question: string) => string
}

/**
 * Stand-in for Ollama on 127.0.0.1 (plan doc 07 §2): version, tags, embed, pull (streamed) and chat (streamed).
 * `stop()` and `start()` reuse the same port, so the app sees Ollama go down and come back.
 */
export class FakeOllama {
  readonly requests: { method: string; path: string; model?: string }[] = []
  models: Set<string>
  private server?: http.Server
  private sockets = new Set<Socket>()
  private port = 0

  constructor(private readonly opts: FakeOllamaOptions = {}) {
    this.models = new Set(opts.models ?? [EMBED_MODEL, CHAT_MODEL])
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`
  }

  async start(): Promise<void> {
    const server = http.createServer((req, res) => void this.handle(req, res))
    server.on('connection', (s) => {
      this.sockets.add(s)
      s.on('close', () => this.sockets.delete(s))
    })
    await new Promise<void>((resolve) => server.listen(this.port, '127.0.0.1', resolve))
    this.port = (server.address() as AddressInfo).port
    this.server = server
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = undefined
    for (const s of this.sockets) s.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let raw = ''
    for await (const part of req) raw += part
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    const path = req.url ?? ''
    this.requests.push({ method: req.method ?? '', path, model: body.model as string | undefined })
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(data))
    }
    const hasModel = (m: unknown) => this.models.has(String(m).replace(/:latest$/, ''))

    if (path === '/api/version') return json(200, { version: '0.0.0-fake' })
    if (path === '/api/tags') return json(200, { models: [...this.models].map((name) => ({ name: `${name}:latest`, digest: 'fake' })) })
    if (path === '/api/embed') {
      if (!hasModel(body.model)) return json(404, { error: `model "${body.model}" not found, try pulling it first` })
      return json(200, { embeddings: (body.input as string[]).map(fakeEmbed) })
    }
    if (path === '/api/pull') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      const total = 274_000_000
      for (const completed of [0, total / 4, total / 2, total]) {
        res.write(JSON.stringify({ status: 'pulling manifest', completed, total }) + '\n')
        await new Promise((r) => setTimeout(r, 150))
      }
      this.models.add(String(body.model).replace(/:latest$/, ''))
      res.end(JSON.stringify({ status: 'success' }) + '\n')
      return
    }
    if (path === '/api/chat') {
      if (!hasModel(body.model)) return json(404, { error: `model "${body.model}" not found` })
      const messages = body.messages as { content: string }[]
      const question = /Question: (.*)$/s.exec(messages[messages.length - 1].content)?.[1] ?? ''
      const answer = this.opts.chatAnswer?.(question) ?? 'NOT_ENOUGH_EVIDENCE'
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      for (const token of answer.match(/\S+\s*/g) ?? []) {
        res.write(JSON.stringify({ message: { role: 'assistant', content: token }, done: false }) + '\n')
      }
      res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n')
      return
    }
    json(404, { error: 'not found' })
  }
}
