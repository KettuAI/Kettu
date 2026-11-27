import inkSheetsUrl from '@renderer/assets/kettu-icon-ink-sheets.svg'
import inkUrl from '@renderer/assets/kettu-icon-ink.svg'
import orangeFlatUrl from '@renderer/assets/kettu-icon-orange-flat.svg'
import paperSheetsUrl from '@renderer/assets/kettu-icon-paper-sheets.svg'
import paperUrl from '@renderer/assets/kettu-icon-paper.svg'
import kettuUrl from '@renderer/assets/kettu-icon.svg'
import { DEFAULT_SETTINGS, normalizeAppIcon, type AppIcon } from '@shared/settings'

/** Vector preview URL for each selectable desktop app icon. */
export const APP_ICON_URLS: Readonly<Record<AppIcon, string>> = {
  kettu: kettuUrl,
  ink: inkUrl,
  paper: paperUrl,
  'orange-flat': orangeFlatUrl,
  'ink-sheets': inkSheetsUrl,
  'paper-sheets': paperSheetsUrl,
}

/** Resolves an icon id (or legacy `'default'`) to its preview URL, falling back to `kettu`. */
export function appIconUrl(icon: AppIcon | string | null | undefined): string {
  const normalized = normalizeAppIcon(icon) ?? DEFAULT_SETTINGS.appearance.appIcon
  return APP_ICON_URLS[normalized]
}
