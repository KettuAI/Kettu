import type { HostInfo } from '@shared/remote/host-admin'
import { useWebHostStore } from '@renderer/stores/web-host'
import { isWeb } from './platform'

/** What a host may offer beyond its sessions: the desktop app has each, the daemon none. */
export type HostFeature = keyof Pick<
  HostInfo,
  'sharing' | 'updates' | 'remoteSwitch' | 'remoteReset'
>

/**
 * Whether the host the page shows has `feature`: in the desktop app always, which is the host;
 * in the web client as the host says, and null until it has.
 */
export function useHostHas(feature: HostFeature): boolean | null {
  const known = useWebHostStore((s) => (s.info ? s.info[feature] : null))
  return isWeb ? known : true
}

/** Runs `start` once the host is known to have `feature`, at once in the desktop app. */
export function whenHostHas(feature: HostFeature, start: () => void): void {
  if (!isWeb || useWebHostStore.getState().info?.[feature]) return start()
  const off = useWebHostStore.subscribe((state) => {
    if (!state.info?.[feature]) return
    off()
    start()
  })
}

/**
 * The i18next options for a sentence about the host: in the web client its `_web` form, which
 * names the host; in the desktop app, which is the host, the sentence as it is.
 */
export function useHostContext(): { context?: 'web'; host?: string } {
  const name = useWebHostStore((s) => s.host?.name ?? '')
  return isWeb ? { context: 'web', host: name } : {}
}
