import { useMemo } from 'react'
import type { BundledTheme } from 'shiki'
import { bundledThemesInfo } from 'shiki/themes'
import { THEME_MODES, type Theme, type ThemeMode } from '@shared/themes'
import { useThemesStore } from '@renderer/stores/themes'

export type CodeThemes = Record<ThemeMode, BundledTheme>

/** Code's Shiki themes for a theme that names none, or one that is not bundled. */
export const DEFAULT_CODE_THEMES: CodeThemes = {
  light: 'github-light-default',
  dark: 'github-dark-default',
}

const BUNDLED: ReadonlySet<string> = new Set(bundledThemesInfo.map((info) => info.id))

export const isCodeTheme = (id: string): id is BundledTheme => BUNDLED.has(id)

/** The Shiki themes code takes in each mode under a theme, or under the built-in one for null. */
export function codeThemes(theme: Theme | null): CodeThemes {
  const [light, dark] = THEME_MODES.map((mode) => {
    const code = theme?.[mode].code
    return code !== undefined && isCodeTheme(code) ? code : DEFAULT_CODE_THEMES[mode]
  }) as [BundledTheme, BundledTheme]
  return { light, dark }
}

/** The shown theme's code themes; the same object while they stay the same. */
export function useCodeThemes(): CodeThemes {
  const { light, dark } = codeThemes(useThemesStore((s) => s.shown))
  return useMemo(() => ({ light, dark }), [light, dark])
}
