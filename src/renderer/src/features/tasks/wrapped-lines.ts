// A chart's text breaks between words: at spaces, and in CJK text between the words
// Intl.Segmenter finds, where the browser alone would break between any two characters.
const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/u
const OPENING = /[([{\uff08\u300c\u300e\u300a\u3008\u3010\u3014\u201c\u2018]$/u
let segmenter: Intl.Segmenter | undefined
let measure: CanvasRenderingContext2D | null | undefined

/**
 * `text` as the runs a line must not break inside, each with the spaces after it. A run ends at a
 * space, or between two CJK words, unless the next line would start with punctuation or this one
 * end on an opening mark. Drawn with `Phrase`, the browser breaks the same way.
 */
export function phraseRuns(text: string): string[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'word' })
  const runs: string[] = []
  let run = ''
  let prev: Intl.SegmentData | undefined
  for (const part of segmenter.segment(text)) {
    if (prev && breaksBetween(prev, part)) {
      runs.push(run)
      run = ''
    }
    run += part.segment
    prev = part
  }
  if (run) runs.push(run)
  return runs
}

function breaksBetween(prev: Intl.SegmentData, next: Intl.SegmentData): boolean {
  if (/^\s/u.test(next.segment)) return false
  if (/\s$/u.test(prev.segment)) return true
  if (!next.isWordLike || OPENING.test(prev.segment)) return false
  return CJK.test(prev.segment.slice(-1)) || CJK.test(next.segment.slice(0, 1))
}

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
 * The lines `text` takes at `width` px in the interface face at `size` px and `weight`, broken
 * between the runs `phraseRuns` gives, so a step's tile can be made tall enough for its words.
 */
export function wrappedLines(text: string, size: number, weight: number, width: number): number {
  const context = measureIn(size, weight)
  if (!context || width <= 0) return 1
  let lines = 1
  let line = 0
  for (const word of phraseRuns(text)) {
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
