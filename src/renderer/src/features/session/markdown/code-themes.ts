import { useMemo } from 'react'
import type { BundledTheme, ThemeRegistration } from 'shiki'
import { bundledThemesInfo } from 'shiki/themes'
import { THEME_MODES, type Theme, type ThemeMode } from '@shared/themes'
import { useThemesStore } from '@renderer/stores/themes'

/** The built-in code themes, drawn from the theme's six syntax colors. */
export const KETTU_CODE_THEMES = { light: 'kettu-light', dark: 'kettu-dark' } as const
type KettuCodeTheme = (typeof KETTU_CODE_THEMES)[ThemeMode]

export type CodeTheme = BundledTheme | KettuCodeTheme
export type CodeThemes = Record<ThemeMode, CodeTheme>

/** Code's themes for a theme that names none, or one that is not bundled. */
export const DEFAULT_CODE_THEMES: CodeThemes = KETTU_CODE_THEMES

const BUNDLED: ReadonlySet<string> = new Set(bundledThemesInfo.map((info) => info.id))

export const isCodeTheme = (id: string): id is BundledTheme => BUNDLED.has(id)

export const isKettuCodeTheme = (id: string): id is KettuCodeTheme =>
  id === KETTU_CODE_THEMES.light || id === KETTU_CODE_THEMES.dark

const syntax = (role: string) => `var(--syntax-${role})`
const PLAIN = 'var(--text-primary)'

// Scopes by the color they take; TextMate styles a token by the longest selector it starts with,
// so operators fall back to the plain text after `keyword`, and word operators back to keywords.
const RULES: [string, string[]][] = [
  [syntax('comment'), ['comment', 'punctuation.definition.comment', 'string.comment']],
  [
    syntax('keyword'),
    [
      'keyword',
      'storage',
      'storage.type',
      'storage.modifier',
      'keyword.operator.new',
      'keyword.operator.expression',
      'keyword.operator.word',
      'keyword.operator.logical.python',
      'variable.language',
      'entity.name.tag',
    ],
  ],
  [PLAIN, ['keyword.operator', 'punctuation', 'meta.brace', 'variable', 'variable.other']],
  [
    syntax('string'),
    [
      'string',
      'string.quoted',
      'string.template',
      'string.regexp',
      'punctuation.definition.string',
      'constant.other.symbol',
      'markup.inline.raw',
      'markup.raw',
      'markup.inserted',
      'markup.underline.link',
    ],
  ],
  [
    syntax('number'),
    [
      'constant.numeric',
      'constant.language',
      'constant.character',
      'constant.other',
      'support.constant',
      'variable.other.constant',
      'variable.other.enummember',
      'keyword.other.unit',
      'markup.deleted',
    ],
  ],
  [
    syntax('function'),
    [
      'entity.name.function',
      'support.function',
      'meta.function-call.generic',
      'entity.other.attribute-name',
      'markup.heading',
      'entity.name.section',
      'meta.diff.range',
      'meta.diff.header',
    ],
  ],
  [
    syntax('type'),
    [
      'entity.name.type',
      'entity.name.class',
      'entity.name.namespace',
      'entity.other.inherited-class',
      'support.type',
      'support.class',
      'storage.type.primitive',
    ],
  ],
]

/** A built-in code theme: the same six colors in both modes, which tokens.css sets per theme. */
export function kettuCodeTheme(mode: ThemeMode): ThemeRegistration {
  return {
    name: KETTU_CODE_THEMES[mode],
    type: mode,
    fg: PLAIN,
    bg: 'var(--bg-code-block)',
    colors: {
      'editor.foreground': PLAIN,
      'editor.background': 'var(--bg-code-block)',
      'editorLineNumber.foreground': syntax('comment'),
    },
    settings: [
      ...RULES.map(([foreground, scope]) => ({ scope, settings: { foreground } })),
      { scope: 'markup.bold', settings: { fontStyle: 'bold' } },
      { scope: 'markup.italic', settings: { fontStyle: 'italic' } },
    ],
  }
}

/** What Shiki and Streamdown take for a theme: its name if bundled, its registration if built in. */
export function codeThemeInput(theme: CodeTheme): BundledTheme | ThemeRegistration {
  return isKettuCodeTheme(theme)
    ? kettuCodeTheme(theme === KETTU_CODE_THEMES.dark ? 'dark' : 'light')
    : theme
}

/** The themes code takes in each mode under a theme, or under the built-in one for null. */
export function codeThemes(theme: Theme | null): CodeThemes {
  const [light, dark] = THEME_MODES.map((mode) => {
    const code = theme?.[mode].code
    return code !== undefined && isCodeTheme(code) ? code : DEFAULT_CODE_THEMES[mode]
  }) as [CodeTheme, CodeTheme]
  return { light, dark }
}

/** The shown theme's code themes; the same object while they stay the same. */
export function useCodeThemes(): CodeThemes {
  const { light, dark } = codeThemes(useThemesStore((s) => s.shown))
  return useMemo(() => ({ light, dark }), [light, dark])
}
