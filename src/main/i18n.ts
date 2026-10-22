// Text main shows itself: the menu, native dialogs and the quit confirmation.

import i18next from 'i18next'
import { i18nOptions, type Locale } from '@shared/locale'
import en from '@shared/locales/en/main.json'
import zhCN from '@shared/locales/zh-CN/main.json'

// English until the settings are read, which is also what the tests see.
void i18next.init(i18nOptions('en', { en: { main: en }, 'zh-CN': { main: zhCN } }, 'main'))

export const t = i18next.getFixedT(null, 'main')

export function setLocale(locale: Locale): void {
  if (i18next.language !== locale) void i18next.changeLanguage(locale)
}

export function locale(): Locale {
  return i18next.language as Locale
}
