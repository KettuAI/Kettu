// State of the updater in main, as every surface reads it.

export type UpdateState =
  | { kind: 'off'; reason: 'development' | 'unsupported' }
  | { kind: 'idle'; checkedAt: number | null } // up to date, or not checked yet
  | { kind: 'checking'; manual: boolean }
  | { kind: 'available'; version: string; mode: 'install' | 'link' } // found, not downloading
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'ready'; version: string } // downloaded and verified
  | { kind: 'error'; message: string; manual: boolean }

export interface UpdateStatus {
  state: UpdateState
  current: string // the running version
  updatedFrom: string | null // set for the first launch after an update
  dismissed: string | null // the version whose notice was dismissed
}

export const RELEASES_URL = 'https://github.com/overbench/overbench/releases'

export function releaseUrl(version: string): string {
  return `${RELEASES_URL}/tag/v${version}`
}
