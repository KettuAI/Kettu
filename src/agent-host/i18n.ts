// Text the host writes for the user, in the language main sends with the settings.

import i18next, { type ParseKeys } from 'i18next'
import { i18nOptions, type Locale } from '@shared/locale'
import en from '@shared/locales/en/host.json'
import zhCN from '@shared/locales/zh-CN/host.json'

// English until host:init, which is also what the tests see.
void i18next.init(i18nOptions('en', { en: { host: en }, 'zh-CN': { host: zhCN } }, 'host'))

export const t = i18next.getFixedT(null, 'host')

export type HostKey = ParseKeys<'host'>

/** A message kept untranslated, for text that is shown again after the language changes. */
export interface HostMessage {
  key: HostKey
  params?: Record<string, string | number>
}

export function translate(message: HostMessage): string {
  return (t as (key: string, params?: Record<string, string | number>) => string)(
    message.key,
    message.params,
  )
}

/** The language the host writes in, for dates and times formatted to match. */
export function currentLocale(): string {
  return i18next.language
}

/** Whether the host's catalog has a message, for keys made from what an agent reports. */
export function hasMessage(key: string): boolean {
  return i18next.exists(key, { ns: 'host' })
}

export function setLocale(locale: Locale): boolean {
  if (i18next.language === locale) return false
  void i18next.changeLanguage(locale)
  return true
}
