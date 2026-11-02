import { describe, expect, it } from 'vitest'
import type { Theme } from '@shared/themes'
import { codeThemes, DEFAULT_CODE_THEMES, kettuCodeTheme } from './code-themes'

const theme = (light?: string, dark?: string): Theme => ({
  name: 'Nord',
  light: { colors: {}, ...(light ? { code: light } : {}) },
  dark: { colors: {}, ...(dark ? { code: dark } : {}) },
})

describe('codeThemes', () => {
  it("takes a theme's bundled Shiki themes", () => {
    expect(codeThemes(theme('rose-pine-dawn', 'nord'))).toEqual({
      light: 'rose-pine-dawn',
      dark: 'nord',
    })
  })

  it('keeps the default for a variant without one, or with one Shiki does not bundle', () => {
    expect(codeThemes(theme(undefined, 'not-a-theme'))).toEqual(DEFAULT_CODE_THEMES)
    expect(codeThemes(null)).toEqual(DEFAULT_CODE_THEMES)
  })
})

describe('kettuCodeTheme', () => {
  it('colors code with the six syntax tokens and the text color only', () => {
    for (const mode of ['light', 'dark'] as const) {
      const colors = new Set(
        kettuCodeTheme(mode).settings!.flatMap(({ settings }) =>
          settings.foreground ? [settings.foreground] : [],
        ),
      )
      expect([...colors].sort()).toEqual(
        [
          'var(--syntax-comment)',
          'var(--syntax-function)',
          'var(--syntax-keyword)',
          'var(--syntax-number)',
          'var(--syntax-string)',
          'var(--syntax-type)',
          'var(--text-primary)',
        ].sort(),
      )
    }
  })
})
