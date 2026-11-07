// The hosted web client's start. Nothing of Kettu shows until the browser is signed in to a Kettu
// account: then it pairs with a host over the relay, or opens the host it showed last. The account's
// hosts are kept apart from any other account's that signed in on the same browser.

import type { AccountStatus, SignedOutReason } from '@shared/account'
import type { KettuApi } from '@shared/ipc'
import { generateKeyPair } from '@shared/remote/noise'
import {
  BROWSER_PAIRING_PATH,
  parseBrowserPairingLink,
  type PairingPayload,
} from '@shared/remote/pairing'
import type { RelayProblem } from '@shared/remote/hosts'
import type { Hello } from '@shared/remote/protocol'
import { useWebHostStore } from '@renderer/stores/web-host'
import { deviceName, type BrowserDevice } from '../device-name'
import { launchApp } from '../launch'
import type { HostLink } from '../link'
import type { Paired, PairFailure, PairProgress } from '../pair'
import type { PairingNotice } from '../pairing-page'
import type { WebSettings } from '../settings'
import { keepStorage, loadDevice, saveDevice, type WebDevice } from '../storage'
import { HostedAccount } from './account'
import { accountUrl } from './config'
import { clearBrowser } from './clear'
import {
  currentHost,
  loadHosts,
  relayDial,
  RelayMiss,
  saveHosts,
  withHost,
  type AccountHosts,
  type HostedHost,
} from './hosts'
import { showProblems } from './problems'

export interface HostedBase {
  settings: WebSettings
  browser: BrowserDevice
  client: Hello['client']
  root: HTMLElement
}

/** Why the page went back to pairing, for the page it reloads into. */
const NOTICE_KEY = 'kettu.notice'
/** Why the service ended the sign-in, for the sign-in page it reloads into. */
const SIGNED_OUT_KEY = 'kettu.signedOut'

const SIGNED_OUT_REASONS: readonly SignedOutReason[] = [
  'account-page',
  'admin',
  'disabled',
  'reused',
  'expired',
  'invalid',
]

function takeSignedOutReason(): SignedOutReason | null {
  try {
    const reason = sessionStorage.getItem(SIGNED_OUT_KEY)
    sessionStorage.removeItem(SIGNED_OUT_KEY)
    return SIGNED_OUT_REASONS.find((known) => known === reason) ?? null
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

function localStore(): Storage | null {
  try {
    return localStorage
  } catch {
    return null
  }
}

const PAIR_FAILURES: Record<RelayProblem, PairFailure> = {
  host_offline: 'host_offline',
  wrong_account: 'wrong_account',
  unreachable: 'unreachable',
  signed_out: 'unreachable',
}

/** A chunk an open page asks for after a newer build replaced it: the page loads again, once. */
function reloadOnStaleChunks(): void {
  const key = 'kettu.reloaded'
  window.addEventListener('vite:preloadError', (event) => {
    try {
      if (sessionStorage.getItem(key)) return
      sessionStorage.setItem(key, '1')
    } catch {
      return
    }
    event.preventDefault()
    location.reload()
  })
}

export async function startHosted(base: HostedBase): Promise<void> {
  reloadOnStaleChunks()
  const account = new HostedAccount({
    accountUrl,
    client: {
      name: deviceName(base.browser),
      os: base.browser.system || 'Web',
      version: __KETTU_VERSION__,
    },
    locale: () => (document.documentElement.lang.startsWith('zh') ? 'zh-CN' : 'en'),
  })
  const back = await account.load().catch((error: unknown) => {
    console.error('Could not read the sign-in', error)
    return null
  })
  if (back !== null) history.replaceState(null, '', back)
  // Another tab signed out or in: this one starts again from what is kept.
  account.onOtherTab(() => location.reload())
  const payload =
    location.pathname === BROWSER_PAIRING_PATH ? parseBrowserPairingLink(location.href) : null
  const status = account.status()
  if (status.state === 'signed-out') {
    const reason = status.reason ?? takeSignedOutReason()
    return showSignIn(base, account, { ...status, reason }, payload !== null)
  }
  if (status.state !== 'signed-in') return
  // A sign-in the service ends while the page is open starts it over, at the sign-in page.
  account.onChanged((next) => {
    if (next.state !== 'signed-out') return
    try {
      if (next.reason) sessionStorage.setItem(SIGNED_OUT_KEY, next.reason)
    } catch {
      // The sign-in page then says nothing of why.
    }
    location.replace('/')
  })
  const accountId = account.accountId!
  const [device, hosts] = await Promise.all([
    loadDevice().catch(() => null),
    loadHosts(accountId).catch((): AccountHosts => ({ hosts: [], current: null })),
  ])
  const host = currentHost(hosts)
  if (payload || !host || !device) return showPairing(base, account, device, hosts, payload)
  return showApp(base, account, device, hosts, host, null)
}

async function showSignIn(
  base: HostedBase,
  account: HostedAccount,
  status: Extract<AccountStatus, { state: 'signed-out' }>,
  pairing: boolean,
): Promise<void> {
  const [{ createRoot }, { SignInPage }, { initSettings }] = await Promise.all([
    import('react-dom/client'),
    import('./sign-in-page'),
    import('@renderer/stores/settings'),
  ])
  await initSettings()
  // Signed out, the page needs no media worker, and one a clear left behind goes now; the app
  // registers it again once signed in.
  void navigator.serviceWorker
    ?.getRegistrations()
    .then((workers) => Promise.all(workers.map((worker) => worker.unregister())))
    .catch(() => {})
  createRoot(base.root).render(
    <SignInPage
      status={status}
      pairing={pairing}
      onSignIn={() => void account.signIn(`${location.pathname}${location.hash}`)}
    />,
  )
}

/** Signs out and goes to the website's sign-in, coming back to this page. */
async function switchAccount(account: HostedAccount): Promise<void> {
  const back = `${location.pathname}${location.hash}`
  await account.signOut()
  await account.signIn(back)
}

async function showPairing(
  base: HostedBase,
  account: HostedAccount,
  device: WebDevice | null,
  hosts: AccountHosts,
  payload: PairingPayload | null,
): Promise<void> {
  const [{ createRoot }, { PairingPage }, { pair }, { initSettings }] = await Promise.all([
    import('react-dom/client'),
    import('../pairing-page'),
    import('../pair'),
    import('@renderer/stores/settings'),
  ])
  await initSettings()
  const accountId = account.accountId!
  const name = deviceName(base.browser)
  const page = createRoot(base.root)
  const onPair = async (
    code: PairingPayload,
    progress: (state: PairProgress) => void,
  ): Promise<boolean> => {
    if (!code.relay) {
      progress({ state: 'failed', reason: 'relay_off' })
      return false
    }
    const key = device?.key ?? (await generateKeyPair())
    const paired = await pair(
      {
        dial: relayDial(
          code.relay,
          () => account.accessToken(),
          () => {},
        ),
        payload: code,
        key,
        client: base.client,
        device: { name, model: base.browser.browser },
        dialFailure: (error) => (error instanceof RelayMiss ? PAIR_FAILURES[error.problem] : null),
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
    await saveHosts(accountId, next)
    void keepStorage()
    // The code is spent; the address alone opens the app from now on.
    history.replaceState(null, '', '/')
    page.unmount()
    await showApp(base, account, kept, next, added, paired)
    return true
  }
  const shown = device ? currentHost(hosts) : null
  page.render(
    <PairingPage
      initial={payload}
      notice={takeNotice()}
      deviceName={name}
      hosted={{
        email: account.status().state === 'signed-in' ? accountEmail(account) : '',
        onSwitchAccount: () => void switchAccount(account),
        onBack: shown ? () => location.replace('/') : null,
      }}
      onPair={onPair}
    />,
  )
}

function accountEmail(account: HostedAccount): string {
  const status = account.status()
  return status.state === 'signed-in' ? status.account.email : ''
}

async function showApp(
  base: HostedBase,
  account: HostedAccount,
  device: WebDevice,
  hosts: AccountHosts,
  host: HostedHost,
  paired: Paired | null,
): Promise<void> {
  const accountId = account.accountId!
  let kept = hosts
  let shown = host
  const keep = (next: AccountHosts): void => {
    kept = next
    void saveHosts(accountId, next).catch((error: unknown) =>
      console.error('Could not keep the hosts', error),
    )
  }
  const without = (): AccountHosts => {
    const rest = kept.hosts.filter((h) => h.relay.id !== shown.relay.id)
    return { hosts: rest, current: rest[0]?.relay.id ?? null }
  }
  const problems = showProblems({
    name: () => shown.name,
    others: () => kept.hosts.filter((h) => h.relay.id !== shown.relay.id),
    open: (id) => open(id),
    switchAccount: () => void switchAccount(account),
  })
  const open = (id: string): void => {
    keep({ ...kept, current: id })
    location.replace('/')
  }
  const accountApi: KettuApi['account'] = {
    status: async () => account.status(),
    check: () => account.check(),
    signIn: () => account.signIn('/'),
    cancelSignIn: async () => account.status(),
    signOut: async () => {
      const status = await account.signOut()
      location.replace('/')
      return status
    },
    signOutAndClear: async () => {
      clearing = true
      await clearBrowser({
        link: linked,
        others: kept.hosts.filter((h) => h.relay.id !== shown.relay.id),
        account,
        key: device.key,
        client: base.client,
      })
      location.replace('/')
    },
    onChanged: (listener) => account.onChanged(listener),
  }
  let linked: HostLink | null = null
  // The host closes this browser's connection as it removes it; nothing more is kept then.
  let clearing = false
  await launchApp(
    {
      dial: relayDial(
        shown.relay,
        () => account.accessToken(),
        (problem) => {
          problems.report(problem)
          // The relay refuses a sign-in the service ended as it does another account's.
          if (problem === 'wrong_account') void account.check()
        },
      ),
      key: device.key,
      hostKey: shown.hostKey,
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
        if (clearing) return
        keep(without())
        try {
          sessionStorage.setItem(NOTICE_KEY, 'removed')
        } catch {
          // The notice is only a courtesy.
        }
        location.replace('/')
      },
      remember: (names, welcome) => {
        shown = { ...shown, ...names, ...(welcome?.relay ? { relay: welcome.relay } : {}) }
        keep({ ...kept, hosts: kept.hosts.map((h) => (h.relay.id === shown.relay.id ? shown : h)) })
        useWebHostStore.setState({ others: othersOf(kept, shown) })
      },
      overrides: (link, api) => {
        linked = link
        problems.follow(link)
        useWebHostStore.setState({ others: othersOf(kept, shown) })
        return {
          hosted: true,
          account: accountApi,
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
