// Text the remote host, the terminal host and the device host write for the user or a paired
// device, in the language main or the daemon sends them.

import i18next, { type ParseKeys } from 'i18next'
import { i18nOptions, type Locale } from './locale'
import en from './locales/en/hosts.json'
import zhCN from './locales/zh-CN/hosts.json'
import type { PortError, PortErrorCode } from './port-rpc'

// Its own instance, so no catalog loaded onto the global one in the same process replaces these.
const i18n = i18next.createInstance()

// English until the host is told its language, which is also what the tests see.
void i18n.init(i18nOptions('en', { en: { hosts: en }, 'zh-CN': { hosts: zhCN } }, 'hosts'))

export const t = i18n.getFixedT(null, 'hosts')

/** The same words in English, for logs. */
export const tEnglish = i18n.getFixedT('en', 'hosts')

export type HostsKey = ParseKeys<'hosts'>

type Say = (key: string, params?: Record<string, string | number>) => string

type Params = Record<string, string | number>

/** A message in the user's language, and the same in English for the log. */
export function words(key: HostsKey, params?: Params): { message: string; log: string } {
  return { message: (t as Say)(key, params), log: (tEnglish as Say)(key, params) }
}

/** A failure worded for the user or a device. */
export function portError(code: PortErrorCode, key: HostsKey, params?: Params): PortError {
  return { code, message: (t as Say)(key, params) }
}

/** The same, with the English words in `log` for a failure the host also logs. */
export function loggedPortError(code: PortErrorCode, key: HostsKey, params?: Params): PortError {
  return { code, ...words(key, params) }
}

export function setLocale(locale: Locale): void {
  if (i18n.language !== locale) void i18n.changeLanguage(locale)
}
