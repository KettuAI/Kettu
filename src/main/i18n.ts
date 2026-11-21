// Text main shows itself: the menu, native dialogs, the quit confirmation and the notch island.

import i18next from 'i18next'
import { i18nOptions, type Locale } from '@shared/locale'
import {
  planWindow as planWindowEn,
  planWindowInText as planWindowInTextEn,
} from '@shared/locales/en/common.json'
import islandEn from '@shared/locales/en/island.json'
import en from '@shared/locales/en/main.json'
import {
  planWindow as planWindowZhCN,
  planWindowInText as planWindowInTextZhCN,
} from '@shared/locales/zh-CN/common.json'
import islandZhCN from '@shared/locales/zh-CN/island.json'
import zhCN from '@shared/locales/zh-CN/main.json'
import { kettuTool as kettuToolEn } from '@shared/locales/en/session.json'
import { kettuTool as kettuToolZhCN } from '@shared/locales/zh-CN/session.json'
import { setLocale as setAgentHostLocale } from '../agent-host/i18n'

// Its own instance, so the agent host's catalog, which some modules main shares code with load
// onto the global one, never replaces these.
const i18n = i18next.createInstance()

// English until the settings are read, which is also what the tests see.
void i18n.init(
  i18nOptions(
    'en',
    {
      // Of the interface's words only what the island's lines use: its names for Kettu's own
      // tools and for plan limit windows.
      en: {
        main: en,
        island: islandEn,
        session: { kettuTool: kettuToolEn },
        common: { planWindow: planWindowEn, planWindowInText: planWindowInTextEn },
      },
      'zh-CN': {
        main: zhCN,
        island: islandZhCN,
        session: { kettuTool: kettuToolZhCN },
        common: { planWindow: planWindowZhCN, planWindowInText: planWindowInTextZhCN },
      },
    },
    'main',
  ),
)

export const t = i18n.getFixedT(null, 'main')
/** The same words in English, for logs. */
export const tEnglish = i18n.getFixedT('en', 'main')
export const islandT = i18n.getFixedT(null, 'island')
/** Kettu's own MCP tools by what they do, as the thread names them. */
export const kettuToolT = i18n.getFixedT(null, 'session', 'kettuTool')
/** The names of plan limit windows, as the interface words them. */
export const planWindowT = i18n.getFixedT(null, 'common')

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
  const bundle = i18n.getResourceBundle(i18n.language, 'island') as { helper?: unknown }
  walk(bundle?.helper, '')
  return flat
}

export function setLocale(locale: Locale): void {
  if (i18n.language !== locale) void i18n.changeLanguage(locale)
  // Agent host code that main or the daemon runs itself writes through the host's own instance.
  setAgentHostLocale(locale)
}

export function locale(): Locale {
  return i18n.language as Locale
}
