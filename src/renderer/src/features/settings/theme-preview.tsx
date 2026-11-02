import { useMemo, type CSSProperties } from 'react'
import type { ThemeColors, ThemeMode } from '@shared/themes'
import { useSettingsStore } from '@renderer/stores/settings'
import { previewColors } from './theme-colors'

/**
 * A theme as a small window: the desk with the sidebar's rows, and a sheet with a title, two lines
 * of text and a button. It draws only the tokens a catalog entry carries, so a theme looks the
 * same in the catalog as once installed. Dark shows the dark window; Light and System the light.
 */
export function ThemePreview({ light, dark }: { light?: ThemeColors; dark?: ThemeColors }) {
  const colorMode = useSettingsStore((s) => s.settings.appearance.theme)
  const mode: ThemeMode = colorMode === 'dark' ? 'dark' : 'light'
  const colors = mode === 'dark' ? dark : light
  const style = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(previewColors(colors, mode)).map(([token, color]) => [`--${token}`, color]),
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
          <span className="mt-auto h-2 w-[26%] self-end rounded-full bg-(image:--primary-gradient)" />
        </span>
      </span>
    </span>
  )
}
