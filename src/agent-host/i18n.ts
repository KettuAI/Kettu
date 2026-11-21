// Text the host writes for the user, in the language main sends with the settings.

import i18next, { type ParseKeys } from 'i18next'
import { i18nOptions, type Locale } from '@shared/locale'
import en from '@shared/locales/en/host.json'
import enSettings from '@shared/locales/en/settings.json'
import enUsage from '@shared/locales/en/usage.json'
import zhCN from '@shared/locales/zh-CN/host.json'
import zhCNSettings from '@shared/locales/zh-CN/settings.json'
import zhCNUsage from '@shared/locales/zh-CN/usage.json'

// English until host:init, which is also what the tests see. The settings' catalogs name the
// rows the settings tools list and change.
void i18next.init(
  i18nOptions(
    'en',
    {
      en: { host: en, settings: enSettings, usage: enUsage },
      'zh-CN': { host: zhCN, settings: zhCNSettings, usage: zhCNUsage },
    },
    'host',
  ),
)

export const t = i18next.getFixedT(null, 'host')

/** Text for agents, which reads the same whatever the user's language. */
export const tEnglish = i18next.getFixedT('en', 'host')

export type HostKey = ParseKeys<'host'>

type Loose = (key: string, params?: Record<string, string | number>) => string

/** A settings row's words in the user's language, from `settings` or as `usage:key`. */
export const tSettings = i18next.getFixedT(null, 'settings') as unknown as Loose

/** The same words in English, for the English name agents also get. */
export const tSettingsEnglish = i18next.getFixedT('en', 'settings') as unknown as Loose

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

/** The same message in English, for agents and logs. */
export function translateEnglish(message: HostMessage): string {
  return (tEnglish as (key: string, params?: Record<string, string | number>) => string)(
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
