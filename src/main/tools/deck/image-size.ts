/** Natural pixel size of a PNG, JPEG, GIF or WebP, read from its header bytes only. `undefined` when the format is unknown or the header is damaged. */
export function readImageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const b = bytes
  const u16be = (i: number): number => (b[i] << 8) | b[i + 1]
  const u32be = (i: number): number => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
  const u16le = (i: number): number => b[i] | (b[i + 1] << 8)
  const u24le = (i: number): number => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)

  // PNG: signature, then IHDR with width/height at 16 and 20.
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { width: u32be(16), height: u32be(20) }

  // GIF: logical screen size at 6 and 8 (little endian).
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { width: u16le(6), height: u16le(8) }

  // JPEG: walk the segments to the first start-of-frame marker.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++
        continue
      }
      const marker = b[i + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
        i += marker === 0xff ? 1 : 2
        continue
      }
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSof) return { height: u16be(i + 5), width: u16be(i + 7) }
      i += 2 + u16be(i + 2)
    }
    return undefined
  }

  // WebP: RIFF....WEBP, then VP8 (lossy), VP8L (lossless) or VP8X (extended).
  if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15])
    if (kind === 'VP8 ') return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff }
    if (kind === 'VP8L') {
      const le = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0 // the 4 bytes after the 0x2f signature, little-endian bitfield
      return { width: (le & 0x3fff) + 1, height: ((le >>> 14) & 0x3fff) + 1 }
    }
    if (kind === 'VP8X') return { width: u24le(24) + 1, height: u24le(27) + 1 }
  }
  return undefined
}
