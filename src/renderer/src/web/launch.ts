// Opening the app over a host's link, which the served page and the hosted one share: the link,
// `window.kettu` on it, the media worker, and following the host's names and version.

import type { KettuApi } from '@shared/ipc'
import type { KeyPair } from '@shared/remote/noise'
import {
  BACKGROUND_PACE_MS,
  parseHostRenamed,
  type DirectAddress,
  type Hello,
  type Welcome,
} from '@shared/remote/protocol'
import { webApi } from './api'
import { hello, HostLink, type Dial } from './link'
import { startMediaWorker } from './media'
import mediaWorker from './media-worker.ts?worker&url'
import type { Paired } from './pair'
import type { WebSettings } from './settings'

export interface LaunchOptions {
  dial: Dial
  key: KeyPair
  hostKey: Uint8Array
  /** The names this browser kept from the last welcome, shown until the next one. */
  known: { name: string; deviceName: string }
  /** The connection pairing left open, which the link takes as its first. */
  paired: Paired | null
  client: Hello['client']
  settings: WebSettings
  /** Where this browser reaches the host directly; null through the relay. */
  address: DirectAddress | null
  storage: Pick<Storage, 'getItem' | 'setItem'> | null
  /** Clears what this browser keeps for the host, and goes back to pairing. */
  forget(link: HostLink): Promise<void>
  /** The host removed this browser. */
  removed(): void
  /** The names, or the welcome, changed: what the next start shows until the host says. */
  remember(known: { name: string; deviceName: string }, welcome: Welcome | null): void
  /** What the hosted build puts in place of the served page's own, given the link and that API. */
  overrides?: (link: HostLink, api: KettuApi) => Partial<KettuApi>
  /** Called once `window.kettu` is set, before the app starts. */
  ready?: () => void
}

export async function launchApp(options: LaunchOptions, root: HTMLElement): Promise<HostLink> {
  let known = options.known
  const link = new HostLink({
    dial: options.dial,
    hostKey: options.hostKey,
    key: options.key,
    hello: hello(options.client),
    ...(options.paired ? { adopt: options.paired } : {}),
    visible: () => document.visibilityState === 'visible',
  })
  options.settings.attach(link)
  const api = webApi(link, options.settings, {
    address: options.address,
    known,
    forget: () => options.forget(link),
    storage: options.storage,
  })
  Object.assign(window.kettu, api, options.overrides?.(link, api))
  options.ready?.()
  startMediaWorker(link, mediaWorker)
  // A page in the back takes patches a batch a second, which the host merges meanwhile.
  const pace = (): void =>
    link.setPace(document.visibilityState === 'visible' ? 0 : BACKGROUND_PACE_MS)
  pace()
  document.addEventListener('visibilitychange', () => {
    pace()
    if (document.visibilityState === 'visible') link.wake()
  })
  window.addEventListener('online', () => link.wake())

  const remember = (next: { name: string; deviceName: string }, welcome: Welcome | null): void => {
    if (!welcome && next.name === known.name && next.deviceName === known.deviceName) return
    known = next
    options.remember(next, welcome)
  }
  let version: string | null = null
  link.onState((state) => {
    if (state.kind === 'connected') {
      const now = state.welcome.host.version
      if (version !== null && now !== version) void offerReload()
      version ??= now
      remember(
        { name: state.welcome.host.name, deviceName: state.welcome.device.name },
        state.welcome,
      )
    } else if (state.kind === 'stopped' && state.reason === 'removed') {
      options.removed()
    }
  })
  link.onMessage((message) => {
    if (message.type === 'renamed' && typeof message.name === 'string') {
      remember({ ...known, deviceName: message.name }, null)
    }
    const name = parseHostRenamed(message)
    if (name) remember({ ...known, name }, null)
  })
  link.start()

  const [{ bootstrap }, { renderApp }, { setRuntimeRelay }, { attachRuntimePort }] =
    await Promise.all([
      import('@renderer/app/bootstrap'),
      import('@renderer/app/render'),
      import('@renderer/features/artifacts/frame-link'),
      import('./runtime-relay'),
    ])
  setRuntimeRelay((url, port) => attachRuntimePort(link, url, port))
  await bootstrap()
  renderApp(root)
  return link
}

async function offerReload(): Promise<void> {
  const [{ toast }, { i18n }] = await Promise.all([
    import('@renderer/components/ui/toast'),
    import('@renderer/lib/i18n'),
  ])
  toast(i18n.t('web:connection.updated'), {
    label: i18n.t('web:connection.reload'),
    onClick: () => location.reload(),
  })
}
