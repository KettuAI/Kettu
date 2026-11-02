// State of the updater in main, as every surface reads it.

import type { Locale } from './locale'

export type UpdateState =
  | { kind: 'off'; reason: 'development' | 'unsupported' }
  | { kind: 'idle'; checkedAt: number | null } // up to date, or not checked yet
  | { kind: 'checking'; manual: boolean }
  // Found, not downloading. In Link mode downloadUrl is the .dmg for this Mac, when there is one.
  | { kind: 'available'; version: string; mode: 'install' | 'link'; downloadUrl: string | null }
  | { kind: 'moving'; version: string } // Update on a read-only volume, moving the app first
  | { kind: 'downloading'; version: string; percent: number; manual: boolean } // manual: Update
  // Downloaded and verified; notes: the release's highlights in each language it has them in.
  | { kind: 'ready'; version: string; notes?: Partial<Record<Locale, string[]>> }
  | { kind: 'error'; message: string; manual: boolean; move?: true } // move: the move failed

export interface UpdateStatus {
  state: UpdateState
  mode: 'install' | 'link' // how this build updates, even while updates are off
  readOnly: boolean // on a read-only volume, which only macOS Install mode tests
  current: string // the running version
  updatedFrom: string | null // set for the first launch after an update
  dismissed: string | null // the version whose notice was dismissed
}

export const RELEASES_URL = 'https://github.com/KettuAI/Kettu/releases'

export function releaseUrl(version: string): string {
  return `${RELEASES_URL}/tag/v${version}`
}
