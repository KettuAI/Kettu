import { describe, expect, it } from 'vitest'
import { isThemeToken, parseThemeFile, THEME_TOKENS, type Theme } from '@shared/themes'
import tokensCss from '@renderer/styles/tokens.css?raw'
import { BUILTIN_COLORS, themeColors, themeContrast, themeFile } from './theme-colors'

// What tokens.css holds that a theme never changes: the white page under an SVG, the shadows and
// the brand marks.
const KEPT_OUT = /^(?:canvas|highlight|elevation-.+|brand-.+)$/

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
    expect(BUILTIN_COLORS.light['bg-app']).toBe('#fdfcf9')
    expect(BUILTIN_COLORS.dark['bg-app']).toBe('#1c1b18')
    // Tokens the dark block leaves alone, and roles, which point at other tokens.
    expect(BUILTIN_COLORS.dark['viewer-scrim']).toBe('oklch(0.14 0.004 85 / 92%)')
    expect(BUILTIN_COLORS.dark['primary-foreground']).toBe('#262521')
    expect(BUILTIN_COLORS.light['terminal-background']).toBe('#efede6')
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
