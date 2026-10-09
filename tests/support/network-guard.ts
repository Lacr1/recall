// Every test process fails loudly on any non-loopback network call (plan doc 07 §1).
const original = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error(`Test attempted a network call to ${url.hostname}`)
  }
  return original(input, init)
}
