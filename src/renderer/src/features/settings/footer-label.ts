// What the settings page's footer says about updates.

import type { UpdateState } from '@shared/updates'

/** A message in the settings namespace, with its values; a pill is an update to get. */
export interface FooterLabel {
  key:
    | 'footer.ready'
    | 'footer.available'
    | 'footer.downloading'
    | 'footer.upToDate'
    | 'about.updates.notChecked'
  values?: Record<string, string | number>
  pill: boolean
}

/** What the footer shows for an update state, or null for nothing. */
export function footerLabel(state: UpdateState): FooterLabel | null {
  switch (state.kind) {
    case 'ready':
      return { key: 'footer.ready', values: { version: state.version }, pill: true }
    case 'available':
      return { key: 'footer.available', values: { version: state.version }, pill: true }
    case 'downloading':
      return {
        key: 'footer.downloading',
        values: { percent: Math.round(state.percent) },
        pill: false,
      }
    case 'idle':
      // About's own words, so the two cannot drift apart.
      return {
        key: state.checkedAt === null ? 'about.updates.notChecked' : 'footer.upToDate',
        pill: false,
      }
    default:
      return null
  }
}
