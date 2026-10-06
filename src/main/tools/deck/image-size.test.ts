import { describe, expect, it } from 'vitest'
import { readImageSize } from './image-size'

const png = (w: number, h: number): Uint8Array => {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 0)
  b.set([w >>> 24, (w >>> 16) & 255, (w >>> 8) & 255, w & 255, h >>> 24, (h >>> 16) & 255, (h >>> 8) & 255, h & 255], 16)
  return b
}

describe('readImageSize', () => {
  it('reads PNG, GIF, JPEG and WebP dimensions from the header', () => {
    expect(readImageSize(png(1200, 800))).toEqual({ width: 1200, height: 800 })
    expect(readImageSize(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xc8, 0x00, 0, 0]))).toEqual({ width: 320, height: 200 })
    // JPEG: SOI, an APP0 segment to skip, then SOF0 (height 300, width 450).
    const jpg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0xc2, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(readImageSize(jpg)).toEqual({ width: 450, height: 300 })
    // WebP VP8X: canvas size is stored minus one in 24 bits at 24 and 27.
    const webp = new Uint8Array(32)
    webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58], 0)
    webp.set([0x1f, 0x03, 0x00, 0xcf, 0x01, 0x00], 24)
    expect(readImageSize(webp)).toEqual({ width: 800, height: 464 })
  })

  it('returns undefined for anything else or a damaged header', () => {
    expect(readImageSize(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined()
    expect(readImageSize(Uint8Array.from([0x89, 0x50]))).toBeUndefined()
    expect(readImageSize(new Uint8Array(0))).toBeUndefined()
  })
})
