import katex from 'katex'

/** Where a formula's source stops making sense, for the fallback to mark. */
export interface TexError {
  message: string
  start: number
  end: number
}

// Commands that reach outside the formula, such as `\href`, stay off, and no size or macro
// expansion can grow without bound, such as `\rule{9999em}{1em}`.
const OPTIONS = {
  throwOnError: true,
  trust: false,
  strict: 'ignore',
  output: 'htmlAndMathml',
  maxSize: 20,
  maxExpand: 1000,
} as const

function texError(tex: string, error: unknown): TexError {
  if (error instanceof katex.ParseError) {
    const start = Number.isInteger(error.position) ? error.position : tex.length
    const end = Math.min(tex.length, start + Math.max(1, error.length || 1))
    return { message: error.rawMessage || error.message, start, end }
  }
  return { message: String(error), start: 0, end: tex.length }
}

/**
 * Draws `tex` into `element` with KaTeX's own DOM builder, which makes every node itself and
 * parses no HTML, or says where the source went wrong and empties the element unless `keep` asks
 * it to keep its last drawing.
 */
export function drawTex(
  tex: string,
  display: boolean,
  element: HTMLElement,
  keep = false,
): TexError | null {
  try {
    katex.render(tex, element, { ...OPTIONS, displayMode: display })
    return null
  } catch (error) {
    if (!keep) element.textContent = ''
    return texError(tex, error)
  }
}

export type FormulaView = 'drawing' | 'source' | 'marked'

/**
 * What a formula shows: KaTeX's drawing, or the source with the part it cannot read marked. While
 * the message is still being written a formula is often half typed, so it keeps its last drawing,
 * or shows its plain source, instead of flashing an error on every chunk.
 */
export function formulaView(failed: boolean, live: boolean, drawn: boolean): FormulaView {
  if (!failed) return 'drawing'
  if (!live) return 'marked'
  return drawn ? 'drawing' : 'source'
}

/** KaTeX's markup for `tex`, or where it goes wrong: what drawTex would draw, as text. */
export function renderTex(
  tex: string,
  display: boolean,
): { ok: true; html: string } | ({ ok: false } & TexError) {
  try {
    return { ok: true, html: katex.renderToString(tex, { ...OPTIONS, displayMode: display }) }
  } catch (error) {
    return { ok: false, ...texError(tex, error) }
  }
}
