import { cjkFontKey, isFontFamilyName, type UserFontRole, type UserFonts } from './settings'

/**
 * Quotes a single font family name for a CSS font-family list, escaping backslashes and double
 * quotes so names with spaces or special characters remain syntactically valid and safe.
 */
export function quoteFontFamily(family: string): string {
  return `"${family.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Places a single user-chosen face ahead of a fallback stack, or returns the fallback as-is. */
export function fontStack(family: string | undefined, fallback: string): string {
  return family ? `${quoteFontFamily(family)}, ${fallback}` : fallback
}

/**
 * Builds the CSS custom property value for `--user-<role>-face`, or returns null when neither a
 * primary face nor an optional Chinese face is configured (preserving the theme stack unchanged).
 *
 * Ordering:
 * - Primary only: `"<primary>", var(--theme-<role>-face)` (identical to the single-font behavior).
 * - Primary + Chinese: `"<primary>", "<cjk>", var(--theme-<role>-face)` so Latin/digits use the
 *   primary face, CJK glyphs fall through to the Chinese face, and the theme stack fills the rest.
 * - Chinese only: `var(--theme-<role>-latin), "<cjk>", var(--theme-<role>-face)` so the theme's
 *   Latin face still draws ASCII/digits while the chosen Chinese face precedes `Platform Chinese`
 *   and `system-ui` (avoiding Chromium's `system-ui` cascade intercepting Chinese glyphs).
 */
export function userFontStack(role: UserFontRole, fonts: UserFonts): string | null {
  const rawPrimary = fonts[role]
  const rawCjk = fonts[cjkFontKey(role)]
  const primary = rawPrimary && isFontFamilyName(rawPrimary) ? rawPrimary : undefined
  const cjk = rawCjk && isFontFamilyName(rawCjk) ? rawCjk : undefined
  const themeFallback = `var(--theme-${role}-face)`
  if (!primary && !cjk) return null
  if (primary && cjk) {
    return `${quoteFontFamily(primary)}, ${quoteFontFamily(cjk)}, ${themeFallback}`
  }
  if (primary) {
    return `${quoteFontFamily(primary)}, ${themeFallback}`
  }
  return `var(--theme-${role}-latin), ${quoteFontFamily(cjk!)}, ${themeFallback}`
}
