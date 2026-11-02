import { describe, expect, it } from 'vitest'
import { formulaView, renderTex } from './tex'

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

  it('keeps a rule from growing past a few lines', () => {
    const result = renderTex('\\rule{9999em}{1em}', false)
    expect(result.ok && result.html).toContain('width:20em')
  })

  it('keeps links out of the formula', () => {
    const result = renderTex('\\href{javascript:alert(1)}{x}', false)
    if (result.ok) expect(result.html).not.toMatch(/href=/)
  })
})

describe('formulaView', () => {
  it('draws a formula KaTeX reads', () => {
    expect(formulaView(false, true, true)).toBe('drawing')
    expect(formulaView(false, false, false)).toBe('drawing')
  })

  it('marks where a finished formula goes wrong', () => {
    expect(formulaView(true, false, false)).toBe('marked')
  })

  it('keeps the last drawing, or the plain source, while the formula is still being written', () => {
    expect(formulaView(true, true, true)).toBe('drawing')
    expect(formulaView(true, true, false)).toBe('source')
  })
})
