// CJK characters break anywhere; other text between words.
const CJK = '\\u2e80-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff\\uff00-\\uffef'
const WORDS = new RegExp(`[${CJK}]|[^\\s${CJK}]+\\s*`, 'gu')
let measure: CanvasRenderingContext2D | null | undefined

/** The canvas set to the interface face at `size` px and `weight`, or null without one. */
function measureIn(size: number, weight: number): CanvasRenderingContext2D | null {
  measure ??= document.createElement('canvas').getContext('2d')
  if (!measure) return null
  const family =
    getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim() ||
    'sans-serif'
  measure.font = `${weight} ${size}px ${family}`
  return measure
}

/**
 * The lines `text` takes at `width` px in the interface face at `size` px and `weight`, broken as
 * the browser breaks it, so a step's tile can be made tall enough for its words.
 */
export function wrappedLines(text: string, size: number, weight: number, width: number): number {
  const context = measureIn(size, weight)
  if (!context || width <= 0) return 1
  let lines = 1
  let line = 0
  for (const word of text.match(WORDS) ?? []) {
    const full = context.measureText(word).width
    if (line > 0 && line + context.measureText(word.trimEnd()).width > width) {
      lines++
      line = full
    } else line += full
  }
  return lines
}

/** How wide `text` is on one line in the interface face at `size` px and `weight`. */
export function textWidth(text: string, size: number, weight: number): number {
  return measureIn(size, weight)?.measureText(text).width ?? 0
}
