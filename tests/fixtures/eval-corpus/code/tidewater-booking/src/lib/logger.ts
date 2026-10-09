const CARD = /\b(?:\d[ -]?){13,19}\b/g
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/g

/** Removes card numbers and email addresses before anything is written to the logs. */
export function redact(message: string): string {
  return message.replace(CARD, '[card]').replace(EMAIL, '[email]')
}

function write(level: string, message: string) {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, message: redact(message) }))
}

export const log = {
  info: (m: string) => write('info', m),
  warn: (m: string) => write('warn', m),
  error: (m: string) => write('error', m)
}
