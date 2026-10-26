import { describe, expect, it } from 'vitest'
import type { Theme } from '@shared/themes'
import { themeCss } from './theme-style'

const theme = (light: Record<string, string>, dark: Record<string, string>): Theme => ({
  name: 'Nord',
  light: { colors: light },
  dark: { colors: dark },
})

describe('themeCss', () => {
  it('writes a rule per variant that outranks tokens.css on <html> and on any subtree', () => {
    expect(themeCss(theme({ 'bg-app': '#eceff4' }, { 'bg-app': ' #2e3440', link: '#88c0d0' })))
      .toBe(`html:root[data-theme='light'],
[data-theme='light'][data-theme] {
  --bg-app: #eceff4;
}

html:root[data-theme='dark'],
[data-theme='dark'][data-theme] {
  --bg-app: #2e3440;
  --link: #88c0d0;
}
`)
  })

  it('writes nothing for the built-in theme or a variant without colors', () => {
    expect(themeCss(null)).toBe('')
    expect(themeCss(theme({}, { 'bg-app': '#000' }))).not.toContain("'light'")
  })

  it('leaves out anything that is not a listed token with a color', () => {
    const css = themeCss(
      theme(
        {
          'bg-app': '#fff;}html{display:none',
          'text-primary': 'var(--x)',
          'brand-claude': '#000',
          'x;}a{b': '#000',
          link: '#123456',
        },
        {},
      ),
    )
    expect(css).toBe(`html:root[data-theme='light'],
[data-theme='light'][data-theme] {
  --link: #123456;
}
`)
  })
})
