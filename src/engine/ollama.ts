import { OLLAMA_URL } from '../shared/constants'

export class OllamaError extends Error {
  constructor(
    readonly code: 'unreachable' | 'timeout' | 'model_missing' | 'context_exceeded' | 'bad_response' | 'cloud_model' | 'aborted',
    message?: string
  ) {
    super(message ?? code)
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

// End-to-end tests point Recall at a fake Ollama server; the loopback check still applies to it.
const BASE_URL = process.env.RECALL_OLLAMA_URL || OLLAMA_URL

/** Recall only ever talks to Ollama on this computer (plan doc 06 §8). */
function assertLoopback(url: string): void {
  if (!LOOPBACK.has(new URL(url).hostname)) throw new OllamaError('unreachable', 'Only a local Ollama endpoint is allowed')
}

/** Ollama can proxy "cloud" models through its local API; those would send text off the machine. */
export function isCloudModel(name: string): boolean {
  return /(^|[:\-])cloud\b/i.test(name)
}

async function request(path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const url = BASE_URL + path
  assertLoopback(url)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new OllamaError('timeout')), timeoutMs)
  const onAbort = () => ctrl.abort(new OllamaError('aborted'))
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      signal: ctrl.signal
    })
    return res
  } catch (err) {
    const reason = ctrl.signal.reason
    if (reason instanceof OllamaError) throw reason
    throw new OllamaError('unreachable', (err as Error).message)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

async function errorFrom(res: Response): Promise<OllamaError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  const msg = body.error ?? `HTTP ${res.status}`
  if (/not found|pull/i.test(msg)) return new OllamaError('model_missing', msg)
  if (/context length/i.test(msg)) return new OllamaError('context_exceeded', msg)
  return new OllamaError('bad_response', msg)
}

export async function getVersion(): Promise<string> {
  const res = await request('/api/version', undefined, 2000)
  if (!res.ok) throw await errorFrom(res)
  return ((await res.json()) as { version: string }).version
}

export async function listModels(): Promise<{ name: string; digest: string }[]> {
  const res = await request('/api/tags', undefined, 3000)
  if (!res.ok) throw await errorFrom(res)
  return ((await res.json()) as { models: { name: string; digest: string }[] }).models ?? []
}

export function hasModel(models: { name: string }[], model: string): boolean {
  return models.some((m) => m.name === model || m.name === `${model}:latest`)
}

export async function embed(model: string, input: string[], opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<number[][]> {
  if (isCloudModel(model)) throw new OllamaError('cloud_model')
  const res = await request('/api/embed', { model, input, truncate: false, keep_alive: '10m' }, opts.timeoutMs ?? 120_000, opts.signal)
  if (!res.ok) throw await errorFrom(res)
  const body = (await res.json()) as { embeddings?: number[][] }
  if (!body.embeddings || body.embeddings.length !== input.length)
    throw new OllamaError('bad_response', 'Embedding count does not match input count')
  return body.embeddings
}

export async function pullModel(model: string, onProgress: (p: { status: string; completed: number; total: number }) => void): Promise<void> {
  if (isCloudModel(model)) throw new OllamaError('cloud_model')
  const res = await request('/api/pull', { model, stream: true }, 60 * 60_000)
  if (!res.ok || !res.body) throw await errorFrom(res)
  for await (const msg of ndjson(res.body)) {
    const m = msg as { status?: string; completed?: number; total?: number; error?: string }
    if (m.error) throw new OllamaError('bad_response', m.error)
    onProgress({ status: m.status ?? '', completed: m.completed ?? 0, total: m.total ?? 0 })
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Streams assistant text. Aborting the signal cancels the HTTP request. */
export async function* chatStream(model: string, messages: ChatMessage[], numCtx: number, signal: AbortSignal): AsyncGenerator<string> {
  if (isCloudModel(model)) throw new OllamaError('cloud_model')
  const res = await request(
    '/api/chat',
    { model, messages, stream: true, keep_alive: '10m', options: { num_ctx: numCtx, temperature: 0.1 } },
    120_000,
    signal
  )
  if (!res.ok || !res.body) throw await errorFrom(res)
  for await (const msg of ndjson(res.body)) {
    const m = msg as { message?: { content?: string }; error?: string; done?: boolean }
    if (m.error) throw new OllamaError('bad_response', m.error)
    if (m.message?.content) yield m.message.content
    if (m.done) return
  }
}

async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const part of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(part, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line) yield JSON.parse(line)
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer)
}
