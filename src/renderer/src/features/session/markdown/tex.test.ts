import { describe, expect, it } from 'vitest'
import { renderTex } from './tex'

describe('renderTex', () => {
  it('draws a formula', () => {
    const result = renderTex('x = \\frac{-b}{2a}', true)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.html).toContain('katex-display')
  })

  it('draws inline formulas without the display wrapper', () => {
    const result = renderTex('c_{hit}', false)
    expect(result.ok && !result.html.includes('katex-display')).toBe(true)
  })

  it('reports where a formula it cannot read goes wrong', () => {
    const tex = 'a + \\notacommand{b}'
    const result = renderTex(tex, true)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(tex.slice(result.start, result.end)).toBe('\\notacommand')
      expect(result.message).toMatch(/Undefined control sequence/)
    }
  })

  it('keeps links out of the formula', () => {
    const result = renderTex('\\href{javascript:alert(1)}{x}', false)
    if (result.ok) expect(result.html).not.toMatch(/href=/)
  })
})
