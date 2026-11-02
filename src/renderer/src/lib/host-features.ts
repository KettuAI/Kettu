import type { HostInfo } from '@shared/remote/host-admin'
import { useHostScope } from '@renderer/stores/host-scope'
import { useOtherHost } from '@renderer/stores/hosts'
import { useWebHostStore } from '@renderer/stores/web-host'
import { isWeb } from './platform'

/** What a host may offer beyond its sessions: the desktop app has each, the daemon none. */
export type HostFeature = keyof Pick<
  HostInfo,
  'sharing' | 'updates' | 'remoteSwitch' | 'remoteReset'
>

/**
 * Whether the host the section shows has `feature`: this computer in the desktop app always; the
 * web client's host or another host as it says, and null until it has.
 */
export function useHostHas(feature: HostFeature): boolean | null {
  const scope = useHostScope()
  const known = scope.useInfoStore((s) => (s.info ? s.info[feature] : null))
  return isWeb || scope.hostId !== null ? known : true
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
 * The i18next options for a sentence about the host: for one reached over the channel, the web
 * client's or another host's, its `_web` form, which names it; for this computer in the desktop
 * app, the sentence as it is.
 */
export function useHostContext(): { context?: 'web'; host?: string } {
  const { hostId } = useHostScope()
  const webName = useWebHostStore((s) => s.host?.name ?? '')
  const otherName = useOtherHost(hostId)?.name ?? ''
  if (hostId !== null) return { context: 'web', host: otherName }
  return isWeb ? { context: 'web', host: webName } : {}
}
