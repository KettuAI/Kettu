import type { TFunction } from 'i18next'
import type { SignInBrowserId } from '@shared/signins'
import { daysBefore, monthDay } from '@renderer/lib/format'

/** When a site was last used, as the sites step lists it. */
export function usedAgo(at: number, t: TFunction<'browser'>): string {
  const days = daysBefore(at)
  if (days <= 0) return t('signIns.used.today')
  if (days === 1) return t('signIns.used.yesterday')
  if (days < 7) return t('signIns.used.days', { count: days })
  if (days < 14) return t('signIns.used.lastWeek')
  if (days < 31) return t('signIns.used.weeks', { count: Math.floor(days / 7) })
  return monthDay(at)
}

/** The keychain item macOS names: Chromium browsers keep their key as "<Name> Safe Storage". */
export function safeStorageItem(browser: SignInBrowserId): string {
  const names: Partial<Record<SignInBrowserId, string>> = {
    chrome: 'Chrome',
    edge: 'Microsoft Edge',
    brave: 'Brave',
    arc: 'Arc',
  }
  return `${names[browser] ?? browser} Safe Storage`
}

/** A browser's short name for sentences: "Chrome" rather than "Google Chrome". */
export function shortBrowserName(name: string): string {
  return name.replace(/^Google /, '').replace(/^Microsoft /, '')
}
