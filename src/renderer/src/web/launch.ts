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
import { hello, HostLink, type Dial, type LinkRoute } from '@shared/remote/link'
import { startMediaWorker } from './media'
import mediaWorker from './media-worker.ts?worker&url'
import type { Paired } from '@shared/remote/pair'
import { encodeRelayBytes } from '@shared/remote/relay'
import { WebPush, type WebPushOptions } from './push'
import type { WebSettings } from './settings'

export interface LaunchOptions {
  dial: Dial
  /** The routes to the host the link races and moves between; `dial` alone when absent. */
  routes?: () => LinkRoute[]
  key: KeyPair
  hostKey: Uint8Array
  /** The names this browser kept from the last welcome, shown until the next one. */
  known: { name: string; deviceName: string }
  /** The connection pairing left open, which the link takes as its first. */
  paired: Paired | null
  client: Hello['client']
  /** The Kettu account this browser is signed in to, which the hello names; none when absent. */
  account?: string | null
  /** What the hello names beyond the shared link's own, as the hosted build's regions. */
  features?: string[]
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
  /** The host's id on the relay as this browser paired with it, which its push key must give. */
  relayId?: string
  /** The account's other hosts, which a click on one's notification opens. */
  others?: WebPushOptions['others']
  /** The browser's push subscription went to the host. */
  pushSynced?(): void
  /** What the hosted build puts in place of the served page's own, given the link and that API. */
  overrides?: (link: HostLink, api: KettuApi) => Partial<KettuApi>
  /** Hosted and relay web clients cannot reach a host's direct port and render live artifacts via virtual sandboxed frames instead. */
  virtualFrames?: boolean
  /** Called once `window.kettu` is set, before the app starts. */
  ready?: () => void
}

export async function launchApp(options: LaunchOptions, root: HTMLElement): Promise<HostLink> {
  let known = options.known
  const link = new HostLink({
    dial: options.dial,
    routes:
      options.routes ??
      (() => [{ key: 'host', relay: options.address === null, dial: options.dial }]),
    hostKey: options.hostKey,
    key: options.key,
    hello: withFeatures(hello(options.client, undefined, options.account), options.features ?? []),
    ...(options.paired ? { adopt: options.paired } : {}),
    visible: () => document.visibilityState === 'visible',
  })
  options.settings.attach(link)
  const push = new WebPush({
    link,
    settings: () => options.settings.current(),
    onSettingsChanged: (listener) => options.settings.onChanged(listener),
    hostId: options.relayId ?? null,
    ...(options.others ? { others: options.others } : {}),
    ...(options.pushSynced ? { synced: options.pushSynced } : {}),
  })
  let virtualFrames: Awaited<
    ReturnType<typeof import('./virtual-frames').createVirtualFrames>
  > | null = null
  if (options.virtualFrames) {
    const { createVirtualFrames } = await import('./virtual-frames')
    virtualFrames = createVirtualFrames(link)
  }
  const api = webApi(link, options.settings, {
    id: encodeRelayBytes(options.hostKey),
    address: options.address,
    known,
    forget: async () => {
      await push.forget()
      await options.forget(link)
    },
    storage: options.storage,
    push,
  })
  const mergedApi: KettuApi = virtualFrames
    ? {
        ...api,
        artifacts: {
          ...api.artifacts,
          open: virtualFrames.open,
          close: virtualFrames.close,
        },
      }
    : api
  Object.assign(window.kettu, mergedApi, options.overrides?.(link, mergedApi))
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
  // Another network, as Wi-Fi joined or left: the routes are compared again.
  const connection = (navigator as Navigator & { connection?: EventTarget }).connection
  connection?.addEventListener('change', () => link.wake())

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
      void push.forget().finally(() => options.removed())
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

  const [
    { bootstrap },
    { renderApp },
    { setRuntimeRelay },
    { setVirtualFrameHost },
    { attachRuntimePort },
  ] = await Promise.all([
    import('@renderer/app/bootstrap'),
    import('@renderer/app/render'),
    import('@renderer/features/artifacts/frame-link'),
    import('@renderer/features/artifacts/virtual-frame-host'),
    import('./runtime-relay'),
  ])
  setVirtualFrameHost(virtualFrames?.host ?? null)
  setRuntimeRelay((url, port) =>
    attachRuntimePort(link, url, port, virtualFrames?.host.allowCapability),
  )
  await bootstrap()
  renderApp(root)
  push.start()
  return link
}

function withFeatures(said: Hello, features: string[]): Hello {
  return features.length > 0 ? { ...said, features: [...(said.features ?? []), ...features] } : said
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
