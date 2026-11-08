import { getStroke } from 'perfect-freehand'

/** A pen stroke's outline as an SVG path, through perfect-freehand. */
export function strokePath(points: readonly number[], width: number, marker: boolean): string {
  const input: number[][] = []
  for (let i = 0; i < points.length; i += 3)
    input.push([points[i]!, points[i + 1]!, points[i + 2]!])
  const outline = getStroke(input, {
    size: width * (marker ? 4 : 2),
    thinning: marker ? 0 : 0.55,
    smoothing: 0.6,
    streamline: 0.45,
    simulatePressure: input.every((p) => p[2] === 0.5),
  })
  if (outline.length < 2) return ''
  const [first, ...rest] = outline
  return `M${first![0]},${first![1]} ` + rest.map(([x, y]) => `L${x},${y}`).join(' ') + ' Z'
}
