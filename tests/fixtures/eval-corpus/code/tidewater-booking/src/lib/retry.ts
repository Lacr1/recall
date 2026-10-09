export interface RetryOptions {
  attempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
}

/**
 * Calls fn until it succeeds, waiting longer after each failure (exponential backoff with full jitter):
 * the wait is a random time between 0 and min(maxDelay, baseDelay * 2^attempt).
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { attempts = 5, baseDelayMs = 200, maxDelayMs = 10000 } = opts
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (i === attempts - 1) break
      const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** i)
      await new Promise((r) => setTimeout(r, Math.random() * cap))
    }
  }
  throw lastError
}
