// State of the updater in main, as every surface reads it.

export type UpdateState =
  | { kind: 'off'; reason: 'development' | 'unsupported' }
  | { kind: 'idle'; checkedAt: number | null } // up to date, or not checked yet
  | { kind: 'checking'; manual: boolean }
  // Found, not downloading. In Link mode downloadUrl is the .dmg for this Mac, when there is one.
  | { kind: 'available'; version: string; mode: 'install' | 'link'; downloadUrl: string | null }
  | { kind: 'downloading'; version: string; percent: number; manual: boolean } // manual: Update
  | { kind: 'ready'; version: string } // downloaded and verified
  | { kind: 'error'; message: string; manual: boolean }

export interface UpdateStatus {
  state: UpdateState
  mode: 'install' | 'link' // how this build updates, even while updates are off
  current: string // the running version
  updatedFrom: string | null // set for the first launch after an update
  dismissed: string | null // the version whose notice was dismissed
}

export const RELEASES_URL = 'https://github.com/overbench/overbench/releases'

export function releaseUrl(version: string): string {
  return `${RELEASES_URL}/tag/v${version}`
}
