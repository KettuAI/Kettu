// CJK characters break anywhere; other text between words.
const CJK = '\\u2e80-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff\\uff00-\\uffef'
const WORDS = new RegExp(`[${CJK}]|[^\\s${CJK}]+\\s*`, 'gu')
let measure: CanvasRenderingContext2D | null | undefined

/**
 * The lines `text` takes at `width` px in the interface face at `size` px and `weight`, broken as
 * the browser breaks it, so a step's tile can be made tall enough for its words.
 */
export function wrappedLines(text: string, size: number, weight: number, width: number): number {
  measure ??= document.createElement('canvas').getContext('2d')
  if (!measure || width <= 0) return 1
  const family =
    getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim() ||
    'sans-serif'
  measure.font = `${weight} ${size}px ${family}`
  let lines = 1
  let line = 0
  for (const word of text.match(WORDS) ?? []) {
    const full = measure.measureText(word).width
    if (line > 0 && line + measure.measureText(word.trimEnd()).width > width) {
      lines++
      line = full
    } else line += full
  }
  return lines
}
