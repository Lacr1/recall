export const EMBED_MODEL = 'nomic-embed-text'
export const EMBED_DIMS = 768
export const DOC_PREFIX = 'search_document: '
export const QUERY_PREFIX = 'search_query: '

// qwen2.5:3b is under the Qwen Research License: fine for this demo, not a shipped default (plan D-04).
export const CHAT_MODEL = 'qwen2.5:3b'

export const OLLAMA_URL = 'http://127.0.0.1:11434'

export const MAX_FILE_BYTES = 50 * 1024 * 1024
export const MAX_PDF_BYTES = 200 * 1024 * 1024

// Methods the renderer may call. Main rejects anything not listed here.
export const RENDERER_METHODS = [
  'getStatus',
  'search',
  'getSearchSuggestions',
  'getDocument',
  'listFailures',
  'removeFolder',
  'rescanFolder',
  'retryFailed',
  'setPaused',
  'pullModel',
  'ask',
  'cancelAsk',
  'deleteAllData'
] as const

export type RendererMethod = (typeof RENDERER_METHODS)[number]
