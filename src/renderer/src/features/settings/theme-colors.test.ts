import { describe, expect, it } from 'vitest'
import {
  isThemeToken,
  parseThemeFile,
  PREVIEW_TOKENS,
  THEME_TOKENS,
  type Theme,
  type ThemeColors,
} from '@shared/themes'
import tokensCss from '@renderer/styles/tokens.css?raw'
import {
  BUILTIN_COLORS,
  previewColors,
  themeColors,
  themeContrast,
  themeFile,
} from './theme-colors'

// What tokens.css holds that a theme never changes: the white page under an SVG and a QR code's
// ink on it, the shadows, the brand marks and the artifact kinds' colors.
const KEPT_OUT = /^(?:canvas|canvas-ink|highlight|elevation-.+|brand-.+|kind-.+)$/

const nord: Theme = {
  name: 'Nord',
  author: 'Arctic Ice Studio',
  version: '1.0.0',
  light: { colors: { 'bg-app': '#eceff4' } },
  dark: { code: 'nord', colors: { 'bg-app': '#2e3440', 'text-tertiary': '#4c566a' } },
}

describe('the built-in colors', () => {
  it('give every token a theme may set a color in both modes', () => {
    for (const colors of [BUILTIN_COLORS.light, BUILTIN_COLORS.dark]) {
      expect(Object.keys(colors)).toEqual([...THEME_TOKENS])
    }
    expect(BUILTIN_COLORS.light['bg-app']).toBe('#ffffff')
    expect(BUILTIN_COLORS.dark['bg-app']).toBe('#1e1e1e')
    // Tokens the dark block leaves alone, and roles, which point at other tokens.
    expect(BUILTIN_COLORS.dark['viewer-scrim']).toBe('oklch(0.14 0 0 / 92%)')
    expect(BUILTIN_COLORS.dark['primary-foreground']).toBe('#252525')
    expect(BUILTIN_COLORS.light['terminal-background']).toBe('#ffffff')
  })

  it('deepen the heatmap from the accent orange', () => {
    for (const mode of ['light', 'dark'] as const) {
      expect(BUILTIN_COLORS[mode]['heat-hue']).toBe(BUILTIN_COLORS[mode]['attention-dot'])
    }
  })

  it('cover every color token of tokens.css, or keep it out on purpose', () => {
    const palette = tokensCss.slice(0, tokensCss.indexOf('/* Roles built from the tokens'))
    const names = new Set([...palette.matchAll(/--([\w-]+)\s*:/g)].map((match) => match[1]!))
    const unlisted = [...names].filter((name) => !isThemeToken(name) && !KEPT_OUT.test(name))
    expect(unlisted).toEqual([])
  })

  it('have no pair under 4.5:1', () => {
    expect(themeContrast(null)).toEqual([])
  })
})

describe('themeFile', () => {
  it('saves the built-in theme as one that installs as it is', () => {
    const parsed = parseThemeFile(themeFile(null))
    expect(parsed).toEqual({
      ok: true,
      ignored: [],
      theme: {
        name: 'My Theme',
        light: { colors: BUILTIN_COLORS.light },
        dark: { colors: BUILTIN_COLORS.dark },
      },
    })
  })

  it("saves a theme with every token, the built-in theme's where it leaves one out", () => {
    const parsed = parseThemeFile(themeFile(nord))
    expect(parsed.ok && parsed.theme).toEqual({
      ...nord,
      light: { colors: { ...BUILTIN_COLORS.light, 'bg-app': '#eceff4' } },
      dark: { code: 'nord', colors: themeColors(nord, 'dark') },
    })
  })

  it('keeps the faces a theme chooses', () => {
    const paper: Theme = { ...nord, name: 'Paper', fonts: { ui: 'inter', prose: 'source-serif-4' } }
    const parsed = parseThemeFile(themeFile(paper))
    expect(parsed.ok && parsed.theme.fonts).toEqual({ ui: 'inter', prose: 'source-serif-4' })
  })
})

describe('previewColors', () => {
  const colors: ThemeColors = {
    'bg-app': '#2e3440',
    'bg-surface': '#353b49',
    'text-primary': '#eceff4',
    link: '#88c0d0',
  }

  it('keeps only the tokens a catalog entry previews', () => {
    expect(Object.keys(previewColors(colors, 'dark'))).toEqual([...PREVIEW_TOKENS])
  })

  it("takes the theme's values, and the built-in value for a token it leaves out", () => {
    const preview = previewColors(colors, 'dark')
    expect(preview['bg-app']).toBe('#2e3440')
    expect(preview['bg-sidebar']).toBe(BUILTIN_COLORS.dark['bg-sidebar'])
    expect(previewColors(undefined, 'light')['bg-app']).toBe(BUILTIN_COLORS.light['bg-app'])
  })

  it('draws a catalog entry as the theme file it was built from', () => {
    // The index carries only these tokens of a theme's file.
    const previewed: readonly string[] = PREVIEW_TOKENS
    const entry = Object.fromEntries(
      Object.entries(colors).filter(([token]) => previewed.includes(token)),
    )
    expect(previewColors(entry, 'dark')).toEqual(previewColors(colors, 'dark'))
  })
})

describe('themeContrast', () => {
  it('lists the pairs a theme leaves under 4.5:1, with the built-in values for the rest', () => {
    expect(themeContrast(nord)).toContainEqual({
      mode: 'dark',
      fg: 'text-tertiary',
      bg: 'bg-app',
      ratio: expect.closeTo(1.7, 1),
    })
  })
})
