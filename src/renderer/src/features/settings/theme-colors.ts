import type { CSSProperties } from 'react'
import {
  contrastIssues,
  parseColor,
  THEME_FORMAT,
  THEME_MODES,
  THEME_TOKENS,
  type ContrastIssue,
  type Theme,
  type ThemeMode,
  type ThemeToken,
} from '@shared/themes'
import tokensCss from '@renderer/styles/tokens.css?raw'

// The built-in theme as values, read from tokens.css, for what a page cannot get from the cascade:
// previews of themes that are not chosen, exported files and the contrast check.

type Colors = Record<ThemeToken, string>

/** The custom properties each rule sets, by its selector, under an at-rule's prelude if any. */
function cssRules(css: string): Map<string, Map<string, string>> {
  const rules = new Map<string, Map<string, string>>()
  const visit = (text: string, within: string) => {
    let at = 0
    for (;;) {
      const open = text.indexOf('{', at)
      if (open < 0) return
      let depth = 1
      let close = open + 1
      for (; close < text.length && depth > 0; close++) {
        if (text[close] === '{') depth++
        else if (text[close] === '}') depth--
      }
      const prelude = text.slice(at, open).replace(/\s+/g, ' ').trim()
      const body = text.slice(open + 1, close - 1)
      if (prelude.startsWith('@')) {
        visit(body, `${prelude} `)
      } else {
        const declarations = new Map<string, string>()
        for (const [, name, value] of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
          declarations.set(name!, value!.replace(/\s+/g, ' ').trim())
        }
        rules.set(within + prelude, declarations)
      }
      at = close
    }
  }
  visit(css.replace(/\/\*[\s\S]*?\*\//g, ''), '')
  return rules
}

/** Every token a theme may set, in each mode, as tokens.css gives it; the roles' references followed. */
export function builtinColors(css: string): Record<ThemeMode, Colors> {
  const rules = cssRules(css)
  const rule = (selector: string) => {
    const found = rules.get(selector)
    if (!found) throw new Error(`tokens.css has no ${selector} rule`)
    return found
  }
  const light = rule(":root, [data-theme='light']")
  const roles = rule(':root, [data-theme]')
  const modes = { light, dark: new Map([...light, ...rule("[data-theme='dark']")]) }
  const value = (mode: ThemeMode, token: string): string => {
    const found = modes[mode].get(token) ?? roles.get(token)
    const reference = found && /^var\(--([\w-]+)\)$/.exec(found)?.[1]
    if (reference) return value(mode, reference)
    if (!found || !parseColor(found)) throw new Error(`tokens.css gives --${token} no color`)
    return found
  }
  const colors = (mode: ThemeMode) =>
    Object.fromEntries(THEME_TOKENS.map((token) => [token, value(mode, token)])) as Colors
  return { light: colors('light'), dark: colors('dark') }
}

export const BUILTIN_COLORS = builtinColors(tokensCss)

/** A theme's colors in a mode, with the built-in value for each token it leaves out. */
export function themeColors(theme: Theme | null, mode: ThemeMode): Colors {
  return { ...BUILTIN_COLORS[mode], ...theme?.[mode].colors }
}

/** Draws a theme's variant on a subtree, whatever theme the page shows. */
export function previewStyle(theme: Theme | null, mode: ThemeMode): CSSProperties {
  const colors = Object.entries(themeColors(theme, mode))
  return Object.fromEntries(colors.map(([token, color]) => [`--${token}`, color]))
}

export function themeContrast(theme: Theme | null): ContrastIssue[] {
  return contrastIssues({ light: themeColors(theme, 'light'), dark: themeColors(theme, 'dark') })
}

/**
 * A theme file with every token set. The built-in theme's is "My Theme", a start to rename, since
 * its own id is taken.
 */
export function themeFile(theme: Theme | null): string {
  const variant = (mode: ThemeMode) => {
    const code = theme?.[mode].code
    return { ...(code ? { code } : {}), colors: themeColors(theme, mode) }
  }
  const file = {
    overbenchTheme: THEME_FORMAT,
    name: theme?.name ?? 'My Theme',
    ...(theme?.author ? { author: theme.author } : {}),
    ...(theme?.version ? { version: theme.version } : {}),
    ...Object.fromEntries(THEME_MODES.map((mode) => [mode, variant(mode)])),
  }
  return `${JSON.stringify(file, null, 2)}\n`
}
