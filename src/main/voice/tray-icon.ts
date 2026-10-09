// Draws the tray icon (the app logo's navy tile and lens, plus a status dot) as PNGs at 16, 24 and 32 px,
// so it stays sharp at 100%, 150% and 200% display scaling. Pure: no Electron imports.
import { crc32, deflateSync } from 'node:zlib'
import type { VoiceState } from '../../shared/voice'

type Rgb = [number, number, number]
const NAVY: Rgb = [0x1f, 0x3a, 0x68]
const WHITE: Rgb = [0xff, 0xff, 0xff]
// The dot's colour is a hint only; the tooltip and menu always say the state in words.
const DOT: Record<VoiceState, Rgb | undefined> = {
  off: undefined,
  starting: [0x99, 0xc2, 0xff],
  listening: [0x2e, 0xa0, 0x43],
  muted: [0x8a, 0x91, 0x99],
  problem: [0xe0, 0x8a, 0x00]
}

/** RGBA pixels, drawn in a 64-unit design space with 4×4 supersampling for smooth edges. */
export function drawTrayIcon(size: number, state: VoiceState): Uint8Array {
  const px = new Uint8Array(size * size * 4)
  const dot = DOT[state]
  const S = 4
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = ((x + (sx + 0.5) / S) / size) * 64
          const v = ((y + (sy + 0.5) / S) / size) * 64
          const c = sample(u, v, dot)
          if (c) {
            r += c[0]
            g += c[1]
            b += c[2]
            a += 1
          }
        }
      }
      const i = (y * size + x) * 4
      if (a) {
        px[i] = Math.round(r / a)
        px[i + 1] = Math.round(g / a)
        px[i + 2] = Math.round(b / a)
        px[i + 3] = Math.round((a / (S * S)) * 255)
      }
    }
  }
  return px
}

function sample(u: number, v: number, dot: Rgb | undefined): Rgb | undefined {
  if (dot) {
    const d = Math.hypot(u - 50, v - 50)
    if (d <= 10) return dot
    if (d <= 13.5) return WHITE
  }
  if (!inRoundedSquare(u, v, 64, 16)) return undefined
  // Lens: a ring and a short handle, as in the logo.
  const ring = Math.hypot(u - 26, v - 26)
  if (ring >= 8 && ring <= 13) return WHITE
  const t = Math.max(0, Math.min(1, (u - 35 + (v - 35)) / 2 / 6))
  if (Math.hypot(u - (35 + t * 6), v - (35 + t * 6)) <= 3) return WHITE
  return NAVY
}

function inRoundedSquare(u: number, v: number, size: number, radius: number): boolean {
  const cx = Math.min(Math.max(u, radius), size - radius)
  const cy = Math.min(Math.max(v, radius), size - radius)
  return Math.hypot(u - cx, v - cy) <= radius && u >= 0 && v >= 0 && u <= size && v <= size
}

/** Minimal PNG encoder for 8-bit RGBA. */
export function encodePng(size: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1)
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** Tooltip text: the state in words, since the dot colour alone is not enough. */
export function trayTooltip(state: VoiceState): string {
  switch (state) {
    case 'listening':
      return 'Recall: listening for "Recall"'
    case 'muted':
      return 'Recall: voice is muted'
    case 'starting':
      return 'Recall: starting voice…'
    case 'problem':
      return 'Recall: voice needs attention'
    case 'off':
      return 'Recall'
  }
}
