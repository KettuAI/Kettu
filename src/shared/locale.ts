// The interface languages and how one is chosen; see docs/design/localization.md.

import type { InitOptions, Resource } from 'i18next'

/** The languages the interface is translated into. English is the source and the fallback. */
export const LOCALES = ['en', 'zh-CN'] as const

export type Locale = (typeof LOCALES)[number]

/** Settings › General › Language: the system's language, or one of the interface languages. */
export type LanguageSetting = 'system' | Locale

export const LANGUAGE_SETTINGS: readonly LanguageSetting[] = ['system', ...LOCALES]

/** Each language in its own words, as language pickers show them whatever the current one. */
export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', 'zh-CN': '简体中文' }

export function isLocale(value: unknown): value is Locale {
  return (LOCALES as readonly unknown[]).includes(value)
}

/**
 * The first of the system's preferred languages that OverBench speaks, else English. Only
 * Simplified Chinese matches `zh-CN`; Traditional Chinese moves on down the list.
 */
export function matchLocale(preferred: readonly string[]): Locale {
  for (const tag of preferred) {
    let locale: Intl.Locale
    try {
      locale = new Intl.Locale(tag).maximize()
    } catch {
      continue
    }
    if (locale.language === 'en') return 'en'
    if (locale.language === 'zh' && locale.script === 'Hans') return 'zh-CN'
  }
  return 'en'
}

export function resolveLocale(language: LanguageSetting, systemLocale: Locale): Locale {
  return language === 'system' ? systemLocale : language
}

/** The i18next options every process shares; each passes the namespaces it shows. */
export function i18nOptions(locale: Locale, resources: Resource, defaultNS: string): InitOptions {
  return {
    lng: locale,
    fallbackLng: 'en',
    supportedLngs: LOCALES,
    resources,
    defaultNS,
    ns: Object.keys(resources.en ?? {}),
    // Resources are bundled, so init and language changes finish synchronously.
    initAsync: false,
    // React escapes text it renders, and main and the host never write HTML.
    interpolation: { escapeValue: false },
    returnNull: false,
  }
}
