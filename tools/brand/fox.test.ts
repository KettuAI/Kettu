import { describe, expect, it } from 'vitest'
import { FRAMINGS, foxSvg } from './fox.mjs'

const ids = (svg: string) => [...svg.matchAll(/ id="([^"]+)"/g)].map((m) => m[1])
const refs = (svg: string) => [...svg.matchAll(/(?:url\(#|href="#)([^)"]+)/g)].map((m) => m[1])
const badge = (svg: string) => svg.match(/<path id="badge" d="([^"]+)"/)?.[1] ?? ''

describe('foxSvg', () => {
  it('draws every framing from vectors, with each reference defined once', () => {
    for (const framing of FRAMINGS) {
      const svg = foxSvg(framing)
      expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 1024 1024"/)
      expect(svg).not.toMatch(/<image|data:/)
      const defined = ids(svg)
      expect(new Set(defined).size).toBe(defined.length)
      for (const ref of refs(svg)) expect(defined).toContain(ref)
    }
  })

  it('ships the tile with rounded corners inside a margin', () => {
    const svg = foxSvg('tile')
    expect(svg).toContain('<g transform="translate(32 32) scale(0.985626)')
    expect(badge(svg)).toContain(' C ')
    expect(svg).toContain('stroke="url(#edgeLight)"')
  })

  it('fills the canvas with square corners for the square and its layers', () => {
    for (const framing of ['square', 'background', 'fox']) {
      const svg = foxSvg(framing)
      expect(svg).toContain('<g transform="translate(0 0) scale(1.051335)')
      expect(badge(svg)).not.toContain(' C ')
      expect(svg).not.toContain('stroke="url(#edgeLight)"')
    }
  })

  it('splits the square into the background and the fox', () => {
    expect(ids(foxSvg('square'))).toEqual(expect.arrayContaining(['background', 'fox']))
    expect(ids(foxSvg('background'))).toContain('background')
    expect(ids(foxSvg('background'))).not.toContain('fox')
    expect(ids(foxSvg('fox'))).toContain('fox')
    expect(ids(foxSvg('fox'))).not.toContain('background')
  })

  it('recolors through the colors map', () => {
    const svg = foxSvg('tile', { colors: { '#fa5615': '#7149FE' } })
    expect(svg).toContain('#7149FE')
    expect(svg).not.toMatch(/#FA5615/i)
  })

  it('rejects an unknown framing', () => {
    expect(() => foxSvg('round')).toThrow('Unknown framing: round')
  })
})
