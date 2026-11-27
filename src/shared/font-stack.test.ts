import { describe, expect, it } from 'vitest'
import { fontStack, quoteFontFamily, userFontStack } from './font-stack'
import { USER_FONT_ROLES, type UserFonts } from './settings'

describe('quoteFontFamily and fontStack', () => {
  it('quotes font names with spaces, CJK characters, backslashes and quotes safely', () => {
    expect(quoteFontFamily('Inter')).toBe('"Inter"')
    expect(quoteFontFamily('Maple Mono NF CN')).toBe('"Maple Mono NF CN"')
    expect(quoteFontFamily('思源黑体 CN')).toBe('"思源黑体 CN"')
    expect(quoteFontFamily('Bad"Font\\Name')).toBe('"Bad\\"Font\\\\Name"')
  })

  it('keeps fallback unchanged when no face is provided', () => {
    expect(fontStack(undefined, 'var(--font-mono)')).toBe('var(--font-mono)')
    expect(fontStack('', 'var(--font-mono)')).toBe('var(--font-mono)')
    expect(fontStack('JetBrains Mono', 'var(--font-mono)')).toBe(
      '"JetBrains Mono", var(--font-mono)',
    )
  })
})

describe('userFontStack', () => {
  it('returns null for every role when both primary and Chinese fonts are unset', () => {
    for (const role of USER_FONT_ROLES) {
      expect(userFontStack(role, {})).toBeNull()
    }
  })

  it('matches the legacy single-font stack exactly when only the primary font is set', () => {
    expect(userFontStack('ui', { ui: 'Segoe UI' })).toBe('"Segoe UI", var(--theme-ui-face)')
    expect(userFontStack('prose', { prose: 'Georgia' })).toBe('"Georgia", var(--theme-prose-face)')
    expect(userFontStack('code', { code: 'Fira Code' })).toBe('"Fira Code", var(--theme-code-face)')
  })

  it('orders primary font first, optional Chinese font second, and theme fallback last', () => {
    const fonts: UserFonts = {
      ui: 'SF Pro',
      uiCjk: 'PingFang SC',
      prose: 'Source Serif 4',
      proseCjk: 'LXGW WenKai',
      code: 'JetBrains Mono',
      codeCjk: '思源黑体 CN',
    }
    expect(userFontStack('ui', fonts)).toBe('"SF Pro", "PingFang SC", var(--theme-ui-face)')
    expect(userFontStack('prose', fonts)).toBe(
      '"Source Serif 4", "LXGW WenKai", var(--theme-prose-face)',
    )
    expect(userFontStack('code', fonts)).toBe(
      '"JetBrains Mono", "思源黑体 CN", var(--theme-code-face)',
    )
  })

  it('places the theme Latin prefix before a Chinese-only override and before the theme fallback', () => {
    expect(userFontStack('ui', { uiCjk: 'LXGW WenKai' })).toBe(
      'var(--theme-ui-latin), "LXGW WenKai", var(--theme-ui-face)',
    )
    expect(userFontStack('prose', { proseCjk: 'Noto Serif CJK SC' })).toBe(
      'var(--theme-prose-latin), "Noto Serif CJK SC", var(--theme-prose-face)',
    )
    expect(userFontStack('code', { codeCjk: 'Microsoft YaHei' })).toBe(
      'var(--theme-code-latin), "Microsoft YaHei", var(--theme-code-face)',
    )
  })

  it('ignores invalid font family names to prevent CSS injection', () => {
    expect(userFontStack('ui', { ui: 'Bad", evil', uiCjk: 'LXGW WenKai' })).toBe(
      'var(--theme-ui-latin), "LXGW WenKai", var(--theme-ui-face)',
    )
    expect(userFontStack('code', { code: 'Fira Code', codeCjk: 'Bad; color: red' })).toBe(
      '"Fira Code", var(--theme-code-face)',
    )
    expect(userFontStack('prose', { prose: 'A, B', proseCjk: 'url(x)' })).toBeNull()
  })
})
