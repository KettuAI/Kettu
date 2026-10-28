import { useMemo, type CSSProperties } from 'react'
import type { ThemeColors, ThemeMode } from '@shared/themes'
import { cn } from '@renderer/lib/utils'
import { useSettingsStore } from '@renderer/stores/settings'
import { previewColors } from './theme-colors'

/**
 * A theme as the chosen color mode shows it: one window for Light or Dark, its light and dark
 * windows side by side for System. Each window draws only the tokens a catalog entry carries, so
 * a theme looks the same in the catalog as once installed.
 */
export function ThemePreview({ light, dark }: { light?: ThemeColors; dark?: ThemeColors }) {
  const colorMode = useSettingsStore((s) => s.settings.appearance.theme)
  const pair = colorMode === 'system'
  return (
    <span
      aria-hidden
      className="relative flex h-26 w-full gap-0.75 overflow-hidden rounded-md bg-surface after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)]"
    >
      {(pair || colorMode === 'light') && <Window mode="light" colors={light} pair={pair} />}
      {(pair || colorMode === 'dark') && <Window mode="dark" colors={dark} pair={pair} />}
    </span>
  )
}

/**
 * The desk with the sidebar's rows, and a sheet with a title, text, a message and the composer.
 * The window's own mode makes the roles built from its tokens, such as the primary gradient,
 * follow them.
 */
function Window({ mode, colors, pair }: { mode: ThemeMode; colors?: ThemeColors; pair: boolean }) {
  const style = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(previewColors(colors, mode)).map(([token, color]) => [`--${token}`, color]),
      ) as CSSProperties,
    [colors, mode],
  )
  return (
    <span
      data-theme={mode}
      style={style}
      className={cn(
        'relative block min-w-0 flex-1 bg-(--bg-sidebar)',
        pair && 'first:rounded-r-sm last:rounded-l-sm',
      )}
    >
      <span className="absolute top-[13%] left-[3%] h-[12%] w-[18%] rounded-sm bg-(--bg-surface) shadow-[inset_0_0_0_var(--hairline)_var(--border-default)]" />
      <span className="absolute top-[36%] left-[6%] h-0.75 w-[12%] rounded-full bg-(--border-strong)" />
      <span className="absolute top-[48%] left-[6%] h-0.75 w-[9.5%] rounded-full bg-(--border-strong)" />
      <span className="absolute top-[60%] left-[6%] h-0.75 w-[11%] rounded-full bg-(--border-strong)" />
      <span className="absolute inset-y-[8%] right-[3.5%] left-[26%] overflow-hidden rounded-sm bg-(--bg-app) shadow-[0_0_0_var(--hairline)_var(--border-subtle)]">
        <span className="absolute top-[15%] left-[9%] h-1 w-[36%] rounded-full bg-(--primary-to)" />
        <span className="absolute top-[29%] left-[9%] h-0.75 w-[64%] rounded-full bg-(--border-strong)" />
        <span className="absolute top-[38%] left-[9%] h-0.75 w-[46%] rounded-full bg-(--border-strong)" />
        <span className="absolute top-[51%] right-[8%] h-[11%] w-[30%] rounded-sm bg-(--bg-subtle)" />
        <span className="absolute inset-x-[7%] bottom-[9%] h-[21%] rounded-sm bg-(--bg-surface) shadow-[inset_0_0_0_var(--hairline)_var(--border-default)]">
          <span
            className={cn(
              'absolute top-1/2 right-1 -translate-y-1/2 rounded-full bg-(image:--primary-gradient)',
              pair ? 'size-2' : 'size-2.5',
            )}
          />
        </span>
      </span>
    </span>
  )
}
