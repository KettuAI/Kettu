import i18next, { type Resource } from 'i18next'
import { initReactI18next } from 'react-i18next'
import { i18nOptions, resolveLocale, type LanguageSetting, type Locale } from '@shared/locale'

// Both languages are bundled: together they are small, and loading one on demand would hold the
// first paint. Main and the agent host translate their own namespaces.
const files = import.meta.glob<Record<string, unknown>>(
  ['@shared/locales/*/*.json', '!@shared/locales/*/{main,host}.json'],
  { eager: true, import: 'default' },
)

function resources(): Resource {
  const out: Resource = {}
  for (const [path, messages] of Object.entries(files)) {
    const [, locale, ns] = /\/([^/]+)\/([^/]+)\.json$/.exec(path)!
    ;(out[locale!] ??= {})[ns!] = messages
  }
  return out
}

// Tests run without the preload.
const systemLocale: Locale = globalThis.window?.overbench?.systemLocale ?? 'en'

void i18next.use(initReactI18next).init(i18nOptions(systemLocale, resources(), 'common'))

export const i18n = i18next

/** The language the interface shows now. */
export function currentLocale(): Locale {
  return i18next.language as Locale
}

/** Switches every `useTranslation` component, the Intl formats and `<html lang>`. */
export function applyLanguage(language: LanguageSetting): void {
  const locale = resolveLocale(language, systemLocale)
  // lang also picks the Han glyphs from the font stack.
  if (typeof document !== 'undefined') document.documentElement.lang = locale
  if (i18next.language !== locale) void i18next.changeLanguage(locale)
}
