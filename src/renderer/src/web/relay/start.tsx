// The start of the web client a relay the owner runs serves. There is no account: the relay is the
// page's own origin, which it reaches with no token, and every host paired through it is listed,
// one shown at a time. The hosts are kept for this relay's origin alone.

import { generateKeyPair } from '@shared/remote/noise'
import {
  BROWSER_PAIRING_PATH,
  parseBrowserPairingLink,
  type PairingPayload,
} from '@shared/remote/pairing'
import { relayOrigin, type HostRelay } from '@shared/remote/relay'
import { dialRelay } from '@shared/remote/relay-device'
import type { Hello } from '@shared/remote/protocol'
import type { Dial } from '@shared/remote/link'
import type { Paired, PairProgress } from '@shared/remote/pair'
import type { Transport } from '@shared/remote/transport'
import { webSocketTransport } from '@shared/remote/websocket-transport'
import { useWebHostStore } from '@renderer/stores/web-host'
import { deviceName, type BrowserDevice } from '../device-name'
import { launchApp } from '../launch'
import type { PairingNotice } from '../pairing-page'
import type { WebSettings } from '../settings'
import { keepStorage, loadDevice, saveDevice, type WebDevice } from '../storage'
import {
  currentHost,
  loadHosts,
  saveHosts,
  withHost,
  type AccountHosts,
  type HostedHost,
} from '../hosted/hosts'

export interface RelayPageBase {
  settings: WebSettings
  browser: BrowserDevice
  client: Hello['client']
  root: HTMLElement
}

/** Why the page went back to pairing, for the page it reloads into. */
const NOTICE_KEY = 'kettu.notice'

/** How long the relay has to join a host. */
const RELAY_TIMEOUT_MS = 15_000

/** This relay, the page's own origin, which is the only one it dials. */
const origin = location.origin

/** The hosts are kept apart for each relay a browser opened the page of. */
const recordKey = `relay:${origin}`

function localStore(): Storage | null {
  try {
    return localStorage
  } catch {
    return null
  }
}

function takeNotice(): PairingNotice {
  try {
    const notice = sessionStorage.getItem(NOTICE_KEY) === 'removed' ? 'removed' : null
    sessionStorage.removeItem(NOTICE_KEY)
    return notice
  } catch {
    return null
  }
}

/** Whether a host's relay is this one, the only relay this page reaches. */
const throughHere = (relay: HostRelay): boolean =>
  relay.urls.some((url) => relayOrigin(url) === origin)

/** Dials the host through this relay; a relay the owner runs takes no token. */
function dialHere(relay: HostRelay): Dial {
  return async () => {
    const result = await dialRelay({
      relays: [origin],
      id: relay.id,
      token: null,
      openSocket: (url) => new WebSocket(url),
      timeoutMs: RELAY_TIMEOUT_MS,
    })
    if (result.kind !== 'joined')
      throw new Error(`The relay did not reach the host: ${result.kind}`)
    const joined: Transport = await webSocketTransport(result.socket, true)
    return joined
  }
}

export async function startRelayPage(base: RelayPageBase): Promise<void> {
  const payload =
    location.pathname === BROWSER_PAIRING_PATH ? parseBrowserPairingLink(location.href) : null
  const [device, hosts] = await Promise.all([
    loadDevice().catch(() => null),
    loadHosts(recordKey).catch((): AccountHosts => ({ hosts: [], current: null })),
  ])
  const host = currentHost(hosts)
  if (payload || !host || !device) return showPairing(base, device, hosts, payload)
  return showApp(base, device, hosts, host, null)
}

async function showPairing(
  base: RelayPageBase,
  device: WebDevice | null,
  hosts: AccountHosts,
  payload: PairingPayload | null,
): Promise<void> {
  const [{ createRoot }, { PairingPage }, { pair }, { initSettings }] = await Promise.all([
    import('react-dom/client'),
    import('../pairing-page'),
    import('@shared/remote/pair'),
    import('@renderer/stores/settings'),
  ])
  await initSettings()
  const name = deviceName(base.browser)
  const page = createRoot(base.root)
  const onPair = async (
    code: PairingPayload,
    progress: (state: PairProgress) => void,
  ): Promise<boolean> => {
    if (!code.relay || !throughHere(code.relay)) {
      progress({ state: 'failed', reason: 'other_relay' })
      return false
    }
    const key = device?.key ?? (await generateKeyPair())
    const paired = await pair(
      {
        dial: dialHere(code.relay),
        payload: code,
        key,
        client: base.client,
        device: { name, model: base.browser.browser },
      },
      progress,
    )
    if (!paired) return false
    const added: HostedHost = {
      hostKey: code.hostKey,
      relay: paired.welcome.relay ?? code.relay,
      name: paired.welcome.host.name,
      deviceName: paired.welcome.device.name,
    }
    const next = withHost(hosts, added)
    const kept: WebDevice = { key, host: null }
    await saveDevice(kept)
    await saveHosts(recordKey, next)
    void keepStorage()
    // The code is spent; the address alone opens the app from now on.
    history.replaceState(null, '', '/')
    page.unmount()
    await showApp(base, kept, next, added, paired)
    return true
  }
  page.render(
    <PairingPage initial={payload} notice={takeNotice()} deviceName={name} onPair={onPair} />,
  )
}

async function showApp(
  base: RelayPageBase,
  device: WebDevice,
  hosts: AccountHosts,
  host: HostedHost,
  paired: Paired | null,
): Promise<void> {
  let kept = hosts
  let shown = host
  const keep = (next: AccountHosts): void => {
    kept = next
    void saveHosts(recordKey, next).catch((error: unknown) =>
      console.error('Could not keep the hosts', error),
    )
  }
  const without = (): AccountHosts => {
    const rest = kept.hosts.filter((h) => h.relay.id !== shown.relay.id)
    return { hosts: rest, current: rest[0]?.relay.id ?? null }
  }
  const open = (id: string): void => {
    keep({ ...kept, current: id })
    location.replace('/')
  }
  await launchApp(
    {
      dial: dialHere(shown.relay),
      key: device.key,
      hostKey: shown.hostKey,
      relayId: shown.relay.id,
      others: {
        has: (id) => id !== shown.relay.id && kept.hosts.some((h) => h.relay.id === id),
        open,
      },
      known: { name: shown.name, deviceName: shown.deviceName },
      paired,
      client: base.client,
      settings: base.settings,
      address: null,
      storage: localStore(),
      forget: async (link) => {
        link.stop()
        keep(without())
        location.replace('/')
      },
      removed: () => {
        keep(without())
        try {
          sessionStorage.setItem(NOTICE_KEY, 'removed')
        } catch {
          // The notice is only a courtesy.
        }
        location.replace('/')
      },
      remember: (names, welcome) => {
        // A host that moved to another relay is no longer reached from this page.
        const relay = welcome?.relay && throughHere(welcome.relay) ? welcome.relay : shown.relay
        shown = { ...shown, ...names, relay }
        keep({ ...kept, hosts: kept.hosts.map((h) => (h.relay.id === shown.relay.id ? shown : h)) })
        useWebHostStore.setState({ others: othersOf(kept, shown) })
      },
      overrides: (_link, api) => {
        useWebHostStore.setState({ others: othersOf(kept, shown) })
        return {
          // The host serves an artifact's frame only on its direct port, which the relay does not
          // reach, so the page shows its preview.
          artifacts: {
            ...api.artifacts,
            open: async () => ({ failed: 'preview_only' }),
            close: async () => {},
          },
        }
      },
      ready: () => {
        useWebHostStore.setState((state) => ({
          actions: state.actions && {
            ...state.actions,
            open,
            add: () => location.assign(BROWSER_PAIRING_PATH),
          },
        }))
      },
    },
    base.root,
  )
}

function othersOf(hosts: AccountHosts, shown: HostedHost): { id: string; name: string }[] {
  return hosts.hosts
    .filter((h) => h.relay.id !== shown.relay.id)
    .map((h) => ({ id: h.relay.id, name: h.name }))
}
