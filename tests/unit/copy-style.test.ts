import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// House style: no em-dashes anywhere in the app. Use a full stop, comma, colon or " · " instead.
const SRC = path.resolve('src')

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name)) : /\.(tsx?|css|html)$/.test(e.name) ? [path.join(dir, e.name)] : []
  )
}

describe('app copy', () => {
  it('has no em-dashes', () => {
    const hits = files(SRC).flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .flatMap((line, i) => (line.includes('—') ? [`${path.relative(SRC, f)}:${i + 1}: ${line.trim()}`] : []))
    )
    expect(hits).toEqual([])
  })
})
