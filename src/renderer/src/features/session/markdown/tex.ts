import katex from 'katex'

/** Where a formula's source stops making sense, for the fallback to mark. */
export interface TexError {
  message: string
  start: number
  end: number
}

// Commands that reach outside the formula, such as `\href`, stay off.
const OPTIONS = {
  throwOnError: true,
  trust: false,
  strict: 'ignore',
  output: 'htmlAndMathml',
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
 * parses no HTML, or empties it and says where the source went wrong.
 */
export function drawTex(tex: string, display: boolean, element: HTMLElement): TexError | null {
  try {
    katex.render(tex, element, { ...OPTIONS, displayMode: display })
    return null
  } catch (error) {
    element.textContent = ''
    return texError(tex, error)
  }
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
