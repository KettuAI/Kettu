// The web client's entry. It loads the channel's primitives, then shows the pairing page or the
// app over a connection to the host that served this page. The renderer's modules read
// `window.kettu` as they load, so it is set before any of them is imported.

import './web.css'

import type { KettuApi } from '@shared/ipc'
import { matchLocale } from '@shared/locale'
import { generateKeyPair } from '@shared/remote/noise'
import {
  BROWSER_PAIRING_PATH,
  parseBrowserPairingLink,
  type PairingPayload,
} from '@shared/remote/pairing'
import { loadPlatformPrimitives } from '@shared/remote/primitives'
import { devicePlatform, pageAddress, webApi } from './api'
import { browserDevice, deviceName } from './device-name'
import { serveFrames } from './frames'
import { channelUrl, dialWebSocket, hello, HostLink } from './link'
import type { Paired, PairProgress } from './pair'
import type { PairingNotice } from './pairing-page'
import { WebSettings } from './settings'
import { keepStorage, loadDevice, saveDevice, type WebDevice } from './storage'

/** Why the page went back to pairing, for the page it reloads into. */
const NOTICE_KEY = 'kettu.notice'

function storage(kind: 'localStorage' | 'sessionStorage'): Storage | null {
  try {
    return window[kind]
  } catch {
    return null
  }
}

const settings = new WebSettings(storage('localStorage'))
const browser = browserDevice(navigator.userAgent)
const client = { kind: 'web', version: __KETTU_VERSION__, platform: browser.system || 'Web' }
const dial = dialWebSocket(channelUrl(location))
const root = document.getElementById('root')!

window.kettu = {
  platform: devicePlatform(navigator),
  client: 'web',
  perf: false,
  systemLocale: matchLocale(navigator.languages),
  settings: {
    get: async () => settings.get(),
    update: async (patch) => settings.update(patch),
    onChanged: (listener) => settings.onChanged(listener),
  },
} as KettuApi

async function showPairing(
  device: WebDevice | null,
  payload: PairingPayload | null,
  notice: PairingNotice,
): Promise<void> {
  const [{ createRoot }, { PairingPage }, { pair }, { initSettings }] = await Promise.all([
    import('react-dom/client'),
    import('./pairing-page'),
    import('./pair'),
    import('@renderer/stores/settings'),
  ])
  await initSettings()
  const name = deviceName(browser)
  const page = createRoot(root)
  const onPair = async (
    code: PairingPayload,
    progress: (state: PairProgress) => void,
  ): Promise<boolean> => {
    const key = device?.key ?? (await generateKeyPair())
    const paired = await pair(
      { dial, payload: code, key, client, device: { name, model: browser.browser } },
      progress,
    )
    if (!paired) return false
    const next: WebDevice = {
      key,
      host: {
        hostKey: code.hostKey,
        name: paired.welcome.host.name,
        deviceName: paired.welcome.device.name,
      },
    }
    await saveDevice(next)
    void keepStorage()
    // The code is spent; the address alone opens the app from now on.
    history.replaceState(null, '', '/')
    page.unmount()
    await showApp(next, paired)
    return true
  }
  page.render(<PairingPage initial={payload} notice={notice} deviceName={name} onPair={onPair} />)
}

async function showApp(device: WebDevice, paired: Paired | null): Promise<void> {
  let host = device.host!
  const link = new HostLink({
    dial,
    hostKey: host.hostKey,
    key: device.key,
    hello: hello(client),
    ...(paired ? { adopt: paired } : {}),
    visible: () => document.visibilityState === 'visible',
  })
  settings.attach(link)
  Object.assign(
    window.kettu,
    webApi(link, settings, {
      address: pageAddress(location),
      known: { name: host.name, deviceName: host.deviceName },
      forget: async () => {
        link.stop()
        await saveDevice({ key: device.key, host: null })
        location.replace('/')
      },
    }),
  )
  serveFrames(link)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') link.wake()
  })
  window.addEventListener('online', () => link.wake())

  // The names the next start shows until the host's welcome says them again.
  const remember = (name: string, deviceName: string): void => {
    if (name === host.name && deviceName === host.deviceName) return
    host = { ...host, name, deviceName }
    void saveDevice({ ...device, host })
  }
  let version: string | null = null
  link.onState((state) => {
    if (state.kind === 'connected') {
      const now = state.welcome.host.version
      if (version !== null && now !== version) void offerReload()
      version ??= now
      remember(state.welcome.host.name, state.welcome.device.name)
    } else if (state.kind === 'stopped' && state.reason === 'removed') {
      void saveDevice({ key: device.key, host: null }).finally(() => {
        storage('sessionStorage')?.setItem(NOTICE_KEY, 'removed')
        location.replace('/')
      })
    }
  })
  link.onMessage((message) => {
    if (message.type === 'renamed' && typeof message.name === 'string') {
      remember(host.name, message.name)
    }
  })
  link.start()

  const [{ bootstrap }, { renderApp }] = await Promise.all([
    import('@renderer/app/bootstrap'),
    import('@renderer/app/render'),
  ])
  await bootstrap()
  renderApp(root)
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

async function start(): Promise<void> {
  await loadPlatformPrimitives()
  const payload =
    location.pathname === BROWSER_PAIRING_PATH ? parseBrowserPairingLink(location.href) : null
  const device = await loadDevice().catch((error: unknown) => {
    console.error('Could not read what this browser keeps', error)
    return null
  })
  const notices = storage('sessionStorage')
  const notice = notices?.getItem(NOTICE_KEY) === 'removed' ? 'removed' : null
  notices?.removeItem(NOTICE_KEY)
  if (device?.host && !payload) return showApp(device, null)
  return showPairing(device, payload, notice)
}

void start()
