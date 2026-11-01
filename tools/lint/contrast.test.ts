import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  checkContrast,
  checkTokens,
  compareDarkBlocks,
  contrastRatio,
  EXEMPT,
  formatRatio,
  luminance,
  MIN_RATIO,
  PAIRS,
  parseColor,
  parseRgba,
  parseTokens,
} from './contrast.mjs'

const SAMPLE = `
/* A comment with { braces } and --not-a-token: #123456; inside. */
:root,
[data-theme='light'] {
  color-scheme: light;
  --bg-app: #ffffff;
  --text-primary: #000;
  --focus: rgb(37 99 235 / 55%);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    --bg-app: #000000;
    --text-primary: #fff;
  }
}

[data-theme='dark'] {
  --bg-app: #000000;
  --text-primary: #ffffff;
}

:root,
[data-theme] {
  --background: var(--bg-app);
}
`

describe('parseColor', () => {
  it('reads opaque hex and rgb()', () => {
    expect(parseColor('#fff')).toEqual([255, 255, 255])
    expect(parseColor('#1B1b1a')).toEqual([27, 27, 26])
    expect(parseColor('#abcf')).toEqual([170, 187, 204])
    expect(parseColor('#112233ff')).toEqual([17, 34, 51])
    expect(parseColor('rgb(37 99 235)')).toEqual([37, 99, 235])
    expect(parseColor('rgb(37, 99, 235)')).toEqual([37, 99, 235])
  })

  it('reads alpha where parseRgba is asked for it', () => {
    expect(parseRgba('rgb(28 27 24 / 6.5%)')).toEqual([28, 27, 24, 0.065])
    expect(parseRgba('rgba(0, 0, 0, 0.5)')).toEqual([0, 0, 0, 0.5])
    expect(parseRgba('#11223380')).toEqual([17, 34, 51, 128 / 255])
    expect(parseRgba('#fff')).toEqual([255, 255, 255, 1])
    expect(parseRgba('oklch(0.6 0.17 255)')).toBeNull()
  })

  it('skips colors with alpha and other forms', () => {
    expect(parseColor('#fff8')).toBeNull()
    expect(parseColor('#11223380')).toBeNull()
    expect(parseColor('rgb(37 99 235 / 55%)')).toBeNull()
    expect(parseColor('rgba(0, 0, 0, 0.5)')).toBeNull()
    expect(parseColor('oklch(0.6 0.17 255)')).toBeNull()
    expect(parseColor('var(--bg-app)')).toBeNull()
    expect(parseColor('red')).toBeNull()
  })
})

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(luminance([255, 255, 255])).toBeCloseTo(1, 10)
    expect(luminance([0, 0, 0])).toBe(0)
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 10)
    expect(contrastRatio([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 10)
    expect(contrastRatio([0x77, 0x77, 0x77], [255, 255, 255])).toBeCloseTo(4.48, 2)
    expect(contrastRatio([0x76, 0x76, 0x76], [255, 255, 255])).toBeGreaterThan(MIN_RATIO)
    expect(contrastRatio([10, 20, 30], [10, 20, 30])).toBe(1)
  })

  it('shows a ratio truncated, so 4.499 never reads as 4.50', () => {
    expect(formatRatio(4.499)).toBe('4.49')
    expect(formatRatio(21)).toBe('21.00')
  })
})

describe('parseTokens', () => {
  it('reads the three blocks and ignores comments and other rules', () => {
    const { light, mediaDark, dark } = parseTokens(SAMPLE)
    expect([...light]).toEqual([
      ['--bg-app', '#ffffff'],
      ['--text-primary', '#000'],
      ['--focus', 'rgb(37 99 235 / 55%)'],
    ])
    expect([...mediaDark]).toEqual([
      ['--bg-app', '#000000'],
      ['--text-primary', '#fff'],
    ])
    expect([...dark]).toEqual([
      ['--bg-app', '#000000'],
      ['--text-primary', '#ffffff'],
    ])
  })

  it('fails when a block is missing', () => {
    expect(() => parseTokens(":root, [data-theme='light'] { --a: #fff; }")).toThrow(/media-dark/)
    expect(() => parseTokens('a { color: red }')).toThrow(/light block is missing/)
  })
})

describe('compareDarkBlocks', () => {
  it('passes identical blocks, whatever the order', () => {
    const a = new Map([
      ['--a', '#000'],
      ['--b', '0 1px 2px rgb(0 0 0 / 5%)'],
    ])
    const b = new Map([...a].reverse())
    expect(compareDarkBlocks(a, b)).toEqual([])
  })

  it('reports a missing property on either side and a different value', () => {
    const a = new Map([
      ['--a', '#000'],
      ['--b', '#111'],
    ])
    const b = new Map([
      ['--a', '#001'],
      ['--c', '#222'],
    ])
    expect(compareDarkBlocks(a, b)).toEqual([
      "--a differs: media dark '#000', dark '#001'",
      "--b is missing from the [data-theme='dark'] block",
      '--c is missing from the media dark block',
    ])
  })
})

describe('checkContrast', () => {
  const blocks = parseTokens(SAMPLE)

  it('merges the dark block over the light one', () => {
    const rows = checkContrast(blocks, [{ fg: '--text-primary', bg: '--bg-app' }])
    expect(rows.map((row) => [row.theme, row.ok])).toEqual([
      ['light', true],
      ['dark', true],
    ])
    expect(rows[0].ratio).toBeCloseTo(21, 10)
  })

  it('fails a pair below 4.5:1 and a token that is missing', () => {
    const low = parseTokens(SAMPLE.replace('--text-primary: #000;', '--text-primary: #777;'))
    const [light] = checkContrast(low, [{ fg: '--text-primary', bg: '--bg-app' }])
    expect(light.ok).toBe(false)
    expect(light.ratio).toBeCloseTo(4.48, 2)

    const [missing] = checkContrast(blocks, [{ fg: '--nope', bg: '--bg-app' }])
    expect(missing).toMatchObject({ ratio: null, ok: false, note: 'missing --nope' })
  })

  it('holds a pair to the ratio its group sets, 4.5:1 when it sets none', () => {
    const low = parseTokens(SAMPLE.replace('--text-primary: #000;', '--text-primary: #777;'))
    const [fill] = checkContrast(low, [{ fg: '--text-primary', bg: '--bg-app', min: 3 }])
    expect(fill).toMatchObject({ ok: true, min: 3 })
    const [text] = checkContrast(low, [{ fg: '--text-primary', bg: '--bg-app' }])
    expect(text).toMatchObject({ ok: false, min: MIN_RATIO })
  })

  it('skips a pair whose foreground is not an opaque color', () => {
    const [skipped] = checkContrast(blocks, [{ fg: '--focus', bg: '--bg-app' }])
    expect(skipped).toMatchObject({ ratio: null, ok: true })
    expect(skipped.note).toMatch(/^skipped/)
  })

  it('lays a translucent surface over each opaque base and keeps the weakest ratio', () => {
    const fill = parseTokens(
      SAMPLE.replace(
        '--focus: rgb(37 99 235 / 55%);',
        '--bg-sidebar: #808080;\n  --bg-hover: rgb(0 0 0 / 50%);',
      ),
    )
    const [light] = checkContrast(fill, [{ fg: '--text-primary', bg: '--bg-hover' }])
    // Black text on half-black over the grey sidebar is the weakest of the two bases.
    expect(light.ratio).toBeCloseTo(contrastRatio([0, 0, 0], [64, 64, 64]), 5)
    expect(light.ok).toBe(false)
  })
})

describe('the real token file', () => {
  const css = readFileSync(
    new URL('../../src/renderer/src/styles/tokens.css', import.meta.url),
    'utf8',
  )

  it('has two identical dark blocks', () => {
    const { mediaDark, dark } = parseTokens(css)
    expect(mediaDark.size).toBeGreaterThan(30)
    expect(compareDarkBlocks(mediaDark, dark)).toEqual([])
  })

  it('declares every token of every pair as an sRGB color, every foreground opaque', () => {
    const { light, dark } = parseTokens(css)
    const tokens = new Map([...light, ...dark])
    for (const { fg, bg } of PAIRS) {
      expect(parseColor(tokens.get(fg) ?? ''), fg).not.toBeNull()
      expect(parseRgba(tokens.get(bg) ?? ''), bg).not.toBeNull()
    }
  })

  it('passes, with every pair checked in both themes', () => {
    const { rows, problems } = checkTokens(css)
    expect(problems).toEqual([])
    expect(rows).toHaveLength(PAIRS.length * 2)
    expect(rows.every((row) => row.ratio !== null && row.ratio >= row.min)).toBe(true)
  })

  it("checks a switch's fill at 3:1 on the page and on its thumb, text at 4.5:1", () => {
    expect(PAIRS.filter(({ fg }) => fg === '--switch-on')).toEqual([
      { fg: '--switch-on', bg: '--bg-app', min: 3 },
      { fg: '--switch-on', bg: '--bg-surface', min: 3 },
    ])
    expect(PAIRS.find(({ fg }) => fg === '--text-primary')?.min).toBe(MIN_RATIO)
  })

  it('keeps the exempt token out of the pairs', () => {
    expect(EXEMPT).toEqual(['--text-disabled'])
    expect(PAIRS.some(({ fg, bg }) => EXEMPT.includes(fg) || EXEMPT.includes(bg))).toBe(false)
  })
})
