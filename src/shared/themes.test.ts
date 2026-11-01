import { describe, expect, it } from 'vitest'
import {
  contrastIssues,
  contrastRatio,
  parseColor,
  parseThemeFile,
  THEME_MAX_BYTES,
  themeSlug,
  toHex,
  type ThemeFileResult,
} from './themes'

const file = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    kettuTheme: 1,
    name: 'Nord',
    light: { colors: { 'bg-app': '#eceff4' } },
    dark: { code: 'nord', colors: { 'bg-app': '#2e3440', 'text-primary': '#eceff4' } },
    ...fields,
  })

const errorOf = (result: ThemeFileResult) => (result.ok ? null : result.error)

describe('parseThemeFile', () => {
  it('reads a theme, trimming its text', () => {
    const result = parseThemeFile(file({ name: '  Nord ', author: 'Arctic Ice', version: '1.2.0' }))
    expect(result).toEqual({
      ok: true,
      ignored: [],
      theme: {
        name: 'Nord',
        author: 'Arctic Ice',
        version: '1.2.0',
        light: { colors: { 'bg-app': '#eceff4' } },
        dark: { code: 'nord', colors: { 'bg-app': '#2e3440', 'text-primary': '#eceff4' } },
      },
    })
  })

  it('takes a variant without colors, and ignores fields it does not know', () => {
    const result = parseThemeFile(
      file({ $schema: 'x', license: 'MIT', light: { code: 'min-light' }, dark: { colors: {} } }),
    )
    expect(result.ok && result.theme.light).toEqual({ colors: {}, code: 'min-light' })
  })

  it('lists unknown tokens and variant fields instead of refusing them', () => {
    const source = file({
      dark: { colors: { 'bg-ap': 'red', 'bg-canvas': 1, 'bg-app': '#000' }, extra: true },
    }).replace('"bg-ap"', '"__proto__":"#fff","bg-ap"')
    const result = parseThemeFile(source)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.ignored).toEqual([
      'dark.extra',
      'dark.colors.__proto__',
      'dark.colors.bg-ap',
      'dark.colors.bg-canvas',
    ])
    expect(result.theme.dark.colors).toEqual({ 'bg-app': '#000' })
    expect(Object.getPrototypeOf(result.theme.dark.colors)).toBe(Object.prototype)
  })

  it('refuses what is not a theme', () => {
    expect(errorOf(parseThemeFile('{'))).toEqual({ code: 'not-json' })
    expect(errorOf(parseThemeFile('[]'))).toEqual({ code: 'not-json' })
    expect(errorOf(parseThemeFile('{"name": "x"}'))).toEqual({ code: 'not-theme' })
    expect(errorOf(parseThemeFile(file({ kettuTheme: '1' })))).toEqual({ code: 'not-theme' })
    expect(errorOf(parseThemeFile(file({ kettuTheme: 0 })))).toEqual({ code: 'not-theme' })
    expect(errorOf(parseThemeFile(file({ kettuTheme: 2 })))).toEqual({ code: 'newer-format' })
    expect(errorOf(parseThemeFile(' '.repeat(THEME_MAX_BYTES + 1)))).toEqual({ code: 'too-large' })
  })

  it('refuses invalid names, authors and versions', () => {
    for (const name of [undefined, '', '   ', 7, 'x'.repeat(65), 'line\nbreak']) {
      expect(errorOf(parseThemeFile(file({ name })))).toEqual({
        code: 'invalid-field',
        path: 'name',
      })
    }
    expect(errorOf(parseThemeFile(file({ author: 3 })))).toEqual({
      code: 'invalid-field',
      path: 'author',
    })
    for (const version of ['1', '1.0', 'v1.0.0', '1.0.0 beta', 1]) {
      expect(errorOf(parseThemeFile(file({ version })))).toEqual({
        code: 'invalid-field',
        path: 'version',
      })
    }
    expect(parseThemeFile(file({ version: '2.0.0-rc.1+build.5' })).ok).toBe(true)
  })

  it("refuses a name that takes the built-in theme's id", () => {
    expect(errorOf(parseThemeFile(file({ name: 'Kettu' })))).toEqual({ code: 'reserved-name' })
    expect(errorOf(parseThemeFile(file({ name: ' over bench ' })))).not.toEqual({
      code: 'reserved-name',
    })
  })

  it('needs both variants, as objects', () => {
    expect(errorOf(parseThemeFile(file({ dark: undefined })))).toEqual({
      code: 'missing-variant',
      variant: 'dark',
    })
    expect(errorOf(parseThemeFile(file({ light: [] })))).toEqual({
      code: 'invalid-field',
      path: 'light',
    })
    expect(errorOf(parseThemeFile(file({ light: { colors: 'red' } })))).toEqual({
      code: 'invalid-field',
      path: 'light.colors',
    })
    expect(errorOf(parseThemeFile(file({ dark: { code: 'Nord Theme' } })))).toEqual({
      code: 'invalid-field',
      path: 'dark.code',
    })
  })

  it('refuses any value that is not one of the color forms', () => {
    const values = [
      'red',
      'var(--bg-app)',
      'url(https://example.com/x.png)',
      '#fff; background: url(x)',
      '#fff}html{display:none',
      'rgb(1 2 3);--x:1',
      'color-mix(in srgb, red, blue)',
      'linear-gradient(red, blue)',
      'rgb(1, 2 3)',
      'expression(alert(1))',
      '',
      7,
      null,
      '#' + 'f'.repeat(120),
    ]
    for (const value of values) {
      expect(
        errorOf(parseThemeFile(file({ light: { colors: { 'text-primary': value } } }))),
      ).toEqual({
        code: 'invalid-color',
        path: 'light.colors.text-primary',
      })
    }
  })

  it('reads the faces a theme chooses, which both variants share', () => {
    const result = parseThemeFile(
      file({ fonts: { ui: 'inter', prose: 'source-serif-4', code: 'system', size: 14 } }),
    )
    expect(result.ok && result.theme.fonts).toEqual({
      ui: 'inter',
      prose: 'source-serif-4',
      code: 'system',
    })
    expect(result.ok && result.ignored).toEqual(['fonts.size'])
    for (const plain of [parseThemeFile(file()), parseThemeFile(file({ fonts: {} }))]) {
      expect(plain.ok && !('fonts' in plain.theme)).toBe(true)
    }
  })

  it('refuses a face Kettu does not ship, or one the role cannot take', () => {
    const cases: [unknown, string][] = [
      [[], 'fonts'],
      ['inter', 'fonts'],
      [{ ui: 'Helvetica' }, 'fonts.ui'],
      [{ prose: "url('x.woff2')" }, 'fonts.prose'],
      [{ prose: 'Inter' }, 'fonts.prose'],
      [{ code: 'inter' }, 'fonts.code'],
      [{ code: 1 }, 'fonts.code'],
    ]
    for (const [fonts, path] of cases) {
      expect(errorOf(parseThemeFile(file({ fonts })))).toEqual({ code: 'invalid-field', path })
    }
  })
})

describe('parseColor', () => {
  const rgb = (value: string) => {
    const color = parseColor(value)
    return color && [color.r, color.g, color.b, color.a].map((c) => Math.round(c * 255))
  }

  it('reads hex in each length', () => {
    expect(rgb('#fff')).toEqual([255, 255, 255, 255])
    expect(rgb('#0008')).toEqual([0, 0, 0, 136])
    expect(rgb('#2E3440')).toEqual([46, 52, 64, 255])
    expect(rgb('#2e344080')).toEqual([46, 52, 64, 128])
    expect(parseColor('#12345')).toBeNull()
  })

  it('reads rgb() in the comma and the space syntax', () => {
    expect(rgb('rgb(20 20 19 / 10%)')).toEqual([20, 20, 19, 26])
    expect(rgb('rgb(20 20 19/10%)')).toEqual([20, 20, 19, 26])
    expect(rgb('rgba(37,99,235,.55)')).toEqual([37, 99, 235, 140])
    expect(rgb('rgb(100%, 50%, 0%)')).toEqual([255, 128, 0, 255])
    expect(rgb('RGB(300 -5 none)')).toEqual([255, 0, 0, 255])
    expect(parseColor('rgb(1 2)')).toBeNull()
    expect(parseColor('rgb(1 2 3 4)')).toBeNull()
    expect(parseColor('rgb(1 2 3 / 1 / 2)')).toBeNull()
    expect(parseColor('rgb(1px 2 3)')).toBeNull()
  })

  it('reads hsl()', () => {
    expect(rgb('hsl(120 100% 25%)')).toEqual([0, 128, 0, 255])
    expect(rgb('hsla(0, 100%, 50%, 0.5)')).toEqual([255, 0, 0, 128])
    expect(rgb('hsl(0.5turn 100 50)')).toEqual([0, 255, 255, 255])
    expect(parseColor('hsl(10% 50% 50%)')).toBeNull()
  })

  it('reads oklch() and oklab(), clipping to sRGB', () => {
    expect(rgb('oklch(1 0 0)')).toEqual([255, 255, 255, 255])
    expect(rgb('oklch(0 0 0)')).toEqual([0, 0, 0, 255])
    expect(rgb('oklch(0.13 0 0 / 92%)')).toEqual([7, 7, 7, 235])
    // #6d28d9 is oklch(0.491 0.241 292.6).
    expect(rgb('oklch(0.491 0.241 292.6)')).toEqual([109, 40, 217, 255])
    expect(rgb('oklab(0.491 0.093 -0.222)')).toEqual([109, 40, 217, 255])
    expect(rgb('oklch(0.9 0.4 145)')?.slice(0, 1)).toEqual([0])
    expect(parseColor('oklch(0.5 0.1)')).toBeNull()
  })

  it('reads transparent and refuses other words', () => {
    expect(parseColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 })
    expect(parseColor('white')).toBeNull()
    expect(parseColor('currentColor')).toBeNull()
  })
})

describe('toHex', () => {
  it('lays a translucent color over the surface under it', () => {
    expect(toHex(parseColor('#2e3440')!)).toBe('#2e3440')
    expect(toHex(parseColor('rgb(0 0 0 / 50%)')!)).toBe('#808080')
    expect(toHex(parseColor('rgb(255 255 255 / 50%)')!, parseColor('#000')!)).toBe('#808080')
  })
})

describe('contrast', () => {
  it('matches the WCAG ratios of known pairs', () => {
    expect(contrastRatio(parseColor('#000')!, parseColor('#fff')!)).toBeCloseTo(21, 5)
    expect(contrastRatio(parseColor('#657b83')!, parseColor('#fdf6e3')!)).toBeCloseTo(4.13, 2)
  })

  it('lays translucent text over its surface first', () => {
    const half = contrastRatio(parseColor('rgb(0 0 0 / 50%)')!, parseColor('#fff')!)
    const gray = parseColor('rgb(127.5 127.5 127.5)')!
    expect(half).toBeCloseTo(contrastRatio(gray, parseColor('#fff')!), 5)
  })

  it('lists the pairs under 4.5:1, a translucent surface laid over the opaque ones', () => {
    const colors = {
      'text-primary': '#000000',
      'text-tertiary': '#657b83',
      'bg-app': '#fdf6e3',
      'bg-sidebar': 'rgb(0 0 0 / 50%)',
    }
    const issues = contrastIssues({ light: colors, dark: colors })
    expect(issues).toContainEqual({
      mode: 'light',
      fg: 'text-tertiary',
      bg: 'bg-app',
      ratio: expect.closeTo(4.13, 2),
    })
    // Half black over bg-app, the one opaque base here, is a mid grey.
    const grey = parseColor('rgb(126.5 123 113.5)')!
    expect(issues).toContainEqual({
      mode: 'light',
      fg: 'text-tertiary',
      bg: 'bg-sidebar',
      ratio: expect.closeTo(contrastRatio(parseColor('#657b83')!, grey), 5),
    })
    expect(issues.some((issue) => issue.fg === 'text-primary')).toBe(false)
  })

  it("holds a group to the ratio it sets, 3:1 for a switch's fill", () => {
    const issues = (fill: string) =>
      contrastIssues({
        light: { 'switch-on': fill, 'bg-app': '#ffffff', 'bg-surface': '#ffffff' },
        dark: {},
      })
    // Under 4.5:1, which text needs, but over 3:1.
    expect(issues('#1d9442')).toEqual([])
    expect(issues('#34c759')).toEqual([
      { mode: 'light', fg: 'switch-on', bg: 'bg-app', ratio: expect.closeTo(2.22, 2) },
      { mode: 'light', fg: 'switch-on', bg: 'bg-surface', ratio: expect.closeTo(2.22, 2) },
    ])
  })
})

describe('themeSlug', () => {
  it('keeps ASCII letters and digits and joins the rest with dashes', () => {
    expect(themeSlug('Rosé Pine')).toBe('rose-pine')
    expect(themeSlug('  Tokyo Night (Day)! ')).toBe('tokyo-night-day')
    expect(themeSlug('墨')).toBe('')
    expect(themeSlug(`${'a'.repeat(47)} b`)).toBe('a'.repeat(47))
  })
})
