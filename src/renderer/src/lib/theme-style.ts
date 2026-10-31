import {
  isThemeFont,
  isThemeToken,
  parseColor,
  THEME_FONT_ROLES,
  THEME_MODES,
  type Theme,
} from '@shared/themes'

/**
 * A theme's tokens as one rule per variant. The first selector outranks tokens.css on <html>, its
 * prefers-color-scheme block included, and the second its [data-theme] blocks on any subtree with
 * a mode of its own, whatever the order of the style sheets. Only listed tokens with values that
 * pass the color check are written, so nothing can end the rule or add a declaration.
 */
export function themeCss(theme: Theme | null): string {
  if (!theme) return ''
  return THEME_MODES.flatMap((mode) => {
    const lines = Object.entries(theme[mode].colors).flatMap(([token, value]) =>
      isThemeToken(token) && typeof value === 'string' && parseColor(value)
        ? [`  --${token}: ${value.trim()};`]
        : [],
    )
    if (lines.length === 0) return []
    return [
      `html:root[data-theme='${mode}'],\n[data-theme='${mode}'][data-theme] {\n${lines.join('\n')}\n}\n`,
    ]
  }).join('\n')
}

/**
 * The faces a theme chooses, as the attributes on <html> that globals.css maps to font stacks;
 * every role is listed, without a face where the theme keeps the built-in one.
 */
export function themeFontAttributes(theme: Theme | null): [string, string | null][] {
  return THEME_FONT_ROLES.map((role) => {
    const face = theme?.fonts?.[role]
    return [`data-font-${role}`, isThemeFont(role, face) ? (face as string) : null]
  })
}

let element: HTMLStyleElement | null = null

/** Writes the theme into its style element in <head> and <html>; the built-in theme clears both. */
export function applyThemeStyle(theme: Theme | null): void {
  if (!element) {
    element = document.createElement('style')
    document.head.append(element)
  }
  element.textContent = themeCss(theme)
  const root = document.documentElement
  for (const [name, face] of themeFontAttributes(theme)) {
    if (face) root.setAttribute(name, face)
    else root.removeAttribute(name)
  }
}
