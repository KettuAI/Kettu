import { useMemo, type CSSProperties } from 'react'
import type { ThemeColors, ThemeMode } from '@shared/themes'
import { useDark } from '@renderer/hooks/use-dark'
import { BUILTIN_COLORS, previewColors } from './theme-colors'

/**
 * A theme as a small window: the desk with the sidebar's rows, and a sheet with a title, two lines
 * of text and a button. It draws only the tokens a catalog entry carries, so a theme looks the
 * same in the catalog as once installed. It shows the mode the app shows, System resolved.
 */
export function ThemePreview({ light, dark }: { light?: ThemeColors; dark?: ThemeColors }) {
  const mode: ThemeMode = useDark() ? 'dark' : 'light'
  const colors = mode === 'dark' ? dark : light
  const style = useMemo(
    () =>
      Object.fromEntries(
        Object.entries({
          ...previewColors(colors, mode),
          // The button in its accent, which an installed theme has and a catalog entry does not.
          'control-on': colors?.['control-on'] ?? BUILTIN_COLORS[mode]['control-on'],
        }).map(([token, color]) => [`--${token}`, color]),
      ) as CSSProperties,
    [colors, mode],
  )
  return (
    <span
      aria-hidden
      className="block aspect-16/10 w-full rounded-2xl shadow-[0_0_0_var(--hairline)_var(--border-default)] transition-shadow duration-(--duration-fast) group-hover/toggle:shadow-[0_0_0_var(--hairline)_var(--border-strong)] group-aria-pressed/toggle:shadow-[0_0_0_2px_var(--control-on)]"
    >
      <span
        data-theme={mode}
        style={style}
        className="flex size-full gap-1.5 overflow-hidden rounded-[inherit] bg-(--bg-sidebar) p-2"
      >
        <span className="flex w-[26%] flex-col gap-1 pt-1.5">
          <span className="h-1 rounded-full bg-(--primary-to) opacity-50" />
          <span className="h-1 rounded-full bg-(--primary-to) opacity-30" />
          <span className="h-2 rounded-sm bg-(--bg-app)" />
          <span className="h-1 rounded-full bg-(--primary-to) opacity-30" />
        </span>
        <span className="flex flex-1 flex-col gap-1.25 rounded-tile bg-(--bg-app) p-2">
          <span className="h-1.25 w-1/2 rounded-sm bg-(--primary-to)" />
          <span className="h-1 w-4/5 rounded-sm bg-(--primary-to) opacity-25" />
          <span className="h-1 w-[64%] rounded-sm bg-(--primary-to) opacity-25" />
          <span className="mt-auto h-2 w-[26%] self-end rounded-full bg-(--control-on)" />
        </span>
      </span>
    </span>
  )
}
