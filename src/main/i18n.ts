// Text main shows itself: the menu, native dialogs, the quit confirmation and the notch island.

import i18next from 'i18next'
import { i18nOptions, type Locale } from '@shared/locale'
import islandEn from '@shared/locales/en/island.json'
import en from '@shared/locales/en/main.json'
import islandZhCN from '@shared/locales/zh-CN/island.json'
import zhCN from '@shared/locales/zh-CN/main.json'

// English until the settings are read, which is also what the tests see.
void i18next.init(
  i18nOptions(
    'en',
    { en: { main: en, island: islandEn }, 'zh-CN': { main: zhCN, island: islandZhCN } },
    'main',
  ),
)

export const t = i18next.getFixedT(null, 'main')
export const islandT = i18next.getFixedT(null, 'island')

/** The island helper's own words in the current language, flat, as `status.running`. */
export function islandHelperStrings(): Record<string, string> {
  const flat: Record<string, string> = {}
  const walk = (value: unknown, prefix: string): void => {
    if (typeof value === 'string') flat[prefix] = value
    else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value))
        walk(child, prefix ? `${prefix}.${key}` : key)
    }
  }
  // English first, so a word the language lacks falls back as `t()` does.
  walk(islandEn.helper, '')
  const bundle = i18next.getResourceBundle(i18next.language, 'island') as { helper?: unknown }
  walk(bundle?.helper, '')
  return flat
}

export function setLocale(locale: Locale): void {
  if (i18next.language !== locale) void i18next.changeLanguage(locale)
}

export function locale(): Locale {
  return i18next.language as Locale
}
