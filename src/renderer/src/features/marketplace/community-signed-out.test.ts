import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import type { AccountStatus } from '@shared/account'
import enMarketplace from '@shared/locales/en/marketplace.json'
import enSettings from '@shared/locales/en/settings.json'
import { DEFAULT_SETTINGS } from '@shared/settings'

interface CapturedButton {
  label: string
  onClick?: () => void
}

const state = vi.hoisted(() => ({
  isWeb: false,
  hostId: null as string | null,
  cloudEnabled: true,
  buttons: [] as CapturedButton[],
  signIn: vi.fn<() => Promise<AccountStatus>>(),
  cancelSignIn: vi.fn<() => Promise<AccountStatus>>(),
  openSettings: vi.fn<(section?: string | null) => void>(),
  openSettingsRow: vi.fn<(section: string, item: string | null, row: string) => void>(),
}))

vi.mock(
  '@hugeicons/core-free-icons',
  () =>
    new Proxy(
      {},
      {
        get: (_target, prop) => (prop === '__esModule' ? true : prop === 'then' ? undefined : prop),
        has: (_target, prop) => prop !== 'then',
      },
    ),
)

vi.mock('zustand', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zustand')>()
  const make = <T>(initializer: StateCreator<T, [], []>) => {
    const api = actual.createStore(initializer)
    const read = <U = T>(selector?: (state: T) => U): U =>
      selector ? selector(api.getState()) : (api.getState() as unknown as U)
    return Object.assign(read, api)
  }
  const create = <T>(initializer?: StateCreator<T, [], []>) =>
    initializer ? make(initializer) : (fn: StateCreator<T, [], []>) => make(fn)
  return { ...actual, create }
})

vi.mock('@renderer/lib/platform', () => ({
  get isWeb() {
    return state.isWeb
  },
  isHosted: false,
  isRelayPage: false,
  isMac: true,
  isWindows: false,
  platform: 'darwin',
  formatShortcut: (shortcut: string) => shortcut,
}))

vi.mock('@renderer/components/affect/button', () => ({
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => {
    const label = typeof children === 'string' ? children : String(children ?? '')
    state.buttons.push({ label, onClick })
    return createElement('button', { type: 'button' }, label)
  },
}))

vi.mock('@renderer/stores/view', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/stores/view')>()
  return {
    ...actual,
    openSettings: (section?: string | null) => state.openSettings(section),
    openSettingsRow: (section: string, item: string | null, row: string) =>
      state.openSettingsRow(section, item, row),
  }
})

vi.mock('@renderer/stores/host-scope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/stores/host-scope')>()
  const { create } = await import('zustand')
  const useScopedSettings = create(() => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.cloud.enabled = true
    return { settings, loaded: true }
  })
  return {
    ...actual,
    useHostScope: () => {
      const settings = structuredClone(DEFAULT_SETTINGS)
      settings.cloud.enabled = state.cloudEnabled
      useScopedSettings.setState({ settings, loaded: true })
      return {
        ...actual.LOCAL_SCOPE,
        hostId: state.hostId,
        useSettingsStore: useScopedSettings,
      }
    },
  }
})

const i18n = i18next.createInstance()

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    ns: ['marketplace', 'settings'],
    defaultNS: 'marketplace',
    resources: { en: { marketplace: enMarketplace, settings: enSettings } },
    interpolation: { escapeValue: false },
  })
})

beforeEach(() => {
  state.isWeb = false
  state.hostId = null
  state.cloudEnabled = true
  state.buttons = []
  state.signIn.mockReset().mockResolvedValue({ state: 'signing-in' })
  state.cancelSignIn.mockReset().mockResolvedValue({
    state: 'signed-out',
    reason: null,
    failure: null,
  })
  state.openSettings.mockReset()
  state.openSettingsRow.mockReset()
  vi.stubGlobal('window', {
    kettu: {
      platform: 'darwin',
      account: {
        signIn: () => state.signIn(),
        cancelSignIn: () => state.cancelSignIn(),
      },
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CommunitySignedOut', () => {
  let CommunitySignedOut: typeof import('./community').CommunitySignedOut
  let useAccountStore: typeof import('@renderer/stores/account').useAccountStore

  beforeAll(async () => {
    const [community, account] = await Promise.all([
      import('./community'),
      import('@renderer/stores/account'),
    ])
    CommunitySignedOut = community.CommunitySignedOut
    useAccountStore = account.useAccountStore
  }, 30_000)

  function renderNote(status: AccountStatus | null): string {
    state.buttons = []
    useAccountStore.setState({ status })
    return renderToStaticMarkup(
      createElement(I18nextProvider, { i18n }, createElement(CommunitySignedOut)),
    )
  }

  it('shows servicesOff and opens Kettu cloud settings when cloud is disabled and signed out', () => {
    state.cloudEnabled = false
    const html = renderNote({ state: 'signed-out', reason: null, failure: null })

    expect(html).toContain(enMarketplace.community.servicesOff)
    expect(html).not.toContain(enMarketplace.community.signedOut)
    expect(state.buttons).toHaveLength(1)
    expect(state.buttons[0]!.label).toBe(enMarketplace.community.openSettings)

    state.buttons[0]!.onClick?.()
    expect(state.openSettingsRow).toHaveBeenCalledWith('general', null, 'cloud')
    expect(state.signIn).not.toHaveBeenCalled()
  })

  it('shows servicesOff regardless of signed-in status when cloud is disabled', () => {
    state.cloudEnabled = false
    const html = renderNote({
      state: 'signed-in',
      account: { id: 'a1', email: 'me@example.com', name: null, avatar: null },
      subscription: 'none',
      plan: null,
      usage: null,
      points: null,
      manageUrl: 'https://www.kettu.sh/account/',
      pointsUrl: 'https://www.kettu.sh/account/points/',
      plainText: false,
    })

    expect(html).toContain(enMarketplace.community.servicesOff)
    expect(state.buttons).toHaveLength(1)
    state.buttons[0]!.onClick?.()
    expect(state.openSettingsRow).toHaveBeenCalledWith('general', null, 'cloud')
    expect(state.signIn).not.toHaveBeenCalled()
  })

  it('renders Sign in and calls signIn when cloud is enabled and signed out', () => {
    state.cloudEnabled = true
    const html = renderNote({ state: 'signed-out', reason: null, failure: null })

    expect(html).toContain(enMarketplace.community.signedOut)
    expect(state.buttons).toHaveLength(1)
    expect(state.buttons[0]!.label).toBe(enMarketplace.community.signIn)

    state.buttons[0]!.onClick?.()
    expect(state.signIn).toHaveBeenCalledTimes(1)
  })

  it('shows waiting status with Open again and Cancel actions while signing-in', () => {
    state.cloudEnabled = true
    const html = renderNote({ state: 'signing-in' })

    expect(html).toContain(enSettings.account.waitingHint)
    expect(state.buttons.map((button) => button.label)).toEqual([
      enMarketplace.community.openAgain,
      enSettings.account.cancel,
    ])

    state.buttons[0]!.onClick?.()
    expect(state.signIn).toHaveBeenCalledTimes(1)

    state.buttons[1]!.onClick?.()
    expect(state.cancelSignIn).toHaveBeenCalledTimes(1)
  })

  it('surfaces sign-in failure feedback when signed out with a failure', () => {
    state.cloudEnabled = true
    const html = renderNote({ state: 'signed-out', reason: null, failure: 'local' })

    expect(html).toContain(enMarketplace.community.signedOut)
    expect(html).toContain(enSettings.account.failures.local)
    expect(html).toContain('role="alert"')
    expect(state.buttons).toHaveLength(1)
    expect(state.buttons[0]!.label).toBe(enMarketplace.community.signIn)
  })

  it('opens Account settings when signed-in locally with cloud enabled', () => {
    state.cloudEnabled = true
    const html = renderNote({
      state: 'signed-in',
      account: { id: 'a1', email: 'me@example.com', name: null, avatar: null },
      subscription: 'none',
      plan: null,
      usage: null,
      points: null,
      manageUrl: 'https://www.kettu.sh/account/',
      pointsUrl: 'https://www.kettu.sh/account/points/',
      plainText: false,
    })

    expect(html).toContain(enMarketplace.community.signedOut)
    expect(state.buttons).toHaveLength(1)
    expect(state.buttons[0]!.label).toBe(enMarketplace.community.openAccount)

    state.buttons[0]!.onClick?.()
    expect(state.openSettings).toHaveBeenCalledWith('account')
  })

  it('omits local actions on a remote host or web client while keeping cloud-off copy accurate', () => {
    state.hostId = 'remote-host-1'
    state.cloudEnabled = false
    const remoteOff = renderNote({ state: 'signed-out', reason: null, failure: null })
    expect(remoteOff).toContain(enMarketplace.community.servicesOff)
    expect(state.buttons).toHaveLength(0)

    state.isWeb = true
    state.hostId = null
    state.cloudEnabled = true
    const webOut = renderNote({ state: 'signed-out', reason: null, failure: null })
    expect(webOut).toContain(enMarketplace.community.signedOut)
    expect(state.buttons).toHaveLength(0)
  })
})
