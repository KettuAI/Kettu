import { CN, US } from 'country-flag-icons/react/3x2'
import type { Locale } from '@shared/locale'

// A new interface language fails type-checking here until it has a flag.
const FLAGS: Record<Locale, typeof US> = { en: US, 'zh-CN': CN }

/** An interface language's flag, drawn as an image since flag emoji do not show on Windows. */
export function LanguageFlag({ locale }: { locale: Locale }) {
  const Flag = FLAGS[locale]
  return <Flag className="k-flag" aria-hidden="true" />
}
