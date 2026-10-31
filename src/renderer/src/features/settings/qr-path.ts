import { encode } from 'uqr'

/**
 * The modules of a QR code as one path, a run of dark modules in a row per rectangle. The lowest
 * error correction keeps the modules large, as a code on a screen is never smudged.
 */
export function qrPath(text: string): { size: number; path: string } {
  const { data, size } = encode(text, { ecc: 'L', border: 0 })
  let path = ''
  data.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      if (!row[x]) {
        x++
        continue
      }
      let end = x
      while (row[end]) end++
      path += `M${x} ${y}h${end - x}v1h${x - end}z`
      x = end
    }
  })
  return { size, path }
}
