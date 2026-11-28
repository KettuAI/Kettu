import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeAll, describe, expect, it } from 'vitest'
import enWeb from '@shared/locales/en/web.json'
import zhWeb from '@shared/locales/zh-CN/web.json'
import type { HostedDiscoveredHost } from './hosted/discovery'
import { PairingView, type HostedPairing } from './pairing-page'

const i18n = i18next.createInstance()

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    defaultNS: 'web',
    ns: ['web'],
    resources: { en: { web: enWeb }, 'zh-CN': { web: zhWeb } },
    interpolation: { escapeValue: false },
  })
})

const HOSTED: HostedPairing = {
  email: 'ada@example.com',
  onSwitchAccount: () => {},
  onBack: null,
  discovery: {
    list: async () => ({ state: 'ok', hosts: [] }),
    pair: () => ({ confirm: () => {}, cancel: () => {}, done: Promise.resolve(false) }),
  },
}

const STUDIO: HostedDiscoveredHost = {
  relayId: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
  hostKey: new Uint8Array(32).fill(1),
  key: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
  name: 'Studio Mac',
  platform: 'darwin',
  relays: ['https://relay.kettu.sh'],
}

const LINUX_BOX: HostedDiscoveredHost = {
  relayId: 'bbbbbbbbbbbbbbbbbbbbbbbbbb',
  hostKey: new Uint8Array(32).fill(2),
  key: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI',
  name: 'Build Box',
  platform: 'linux',
  relays: ['https://relay.kettu.sh'],
}

function renderView(props: Partial<Parameters<typeof PairingView>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(PairingView, {
        notice: null,
        deviceName: 'Chrome · macOS',
        hosted: HOSTED,
        progress: null,
        added: false,
        link: '',
        invalid: false,
        onLink: () => {},
        onSubmit: () => {},
        ...props,
      }),
    ),
  )
}

function keyPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...keyPaths(v as Record<string, unknown>, full))
    } else {
      keys.push(full)
    }
  }
  return keys.sort()
}

describe('web locale parity', () => {
  it('keeps en and zh-CN web.json keys identical', () => {
    expect(keyPaths(zhWeb as unknown as Record<string, unknown>)).toEqual(
      keyPaths(enWeb as unknown as Record<string, unknown>),
    )
  })
})

describe('PairingView hosted account discovery', () => {
  it('renders loading skeletons before the relay answers', () => {
    const html = renderView({ discovered: null, refreshing: true })
    expect(html).toContain('Computers on your account')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('Pair with a link instead')
    expect(html).not.toContain('id="pairing-link"')
  })

  it('lists online account computers with platform labels and connect actions', () => {
    const html = renderView({
      discovered: { state: 'ok', hosts: [STUDIO, LINUX_BOX] },
    })
    expect(html).toContain('Studio Mac')
    expect(html).toContain('macOS')
    expect(html).toContain('Connect to Studio Mac')
    expect(html).toContain('Build Box')
    expect(html).toContain('Linux')
    expect(html).toContain('Connect to Build Box')
    expect(html).toContain('Pair with a link instead')
  })

  it('renders calm empty, unavailable, and signed-out states', () => {
    const emptyHtml = renderView({ discovered: { state: 'ok', hosts: [] } })
    expect(emptyHtml).toContain('No available computers')

    const unavailableHtml = renderView({ discovered: { state: 'unavailable' } })
    expect(unavailableHtml).toContain('Cannot reach the Kettu relay')
    expect(unavailableHtml).toContain('Try again')

    const signedOutHtml = renderView({ discovered: { state: 'signed_out' } })
    expect(signedOutHtml).toContain('Sign-in expired')
    expect(signedOutHtml).toContain('Sign in')
  })

  it('shows the secondary manual pairing link form when toggled open and keeps Back accessible', () => {
    const html = renderView({
      hosted: { ...HOSTED, onBack: () => {} },
      discovered: { state: 'ok', hosts: [STUDIO] },
      linkOpen: true,
    })
    expect(html).toContain('id="pairing-link"')
    expect(html).toContain('https://kettu.sh/pair#…')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('Back')
  })

  it('renders discovery connecting, 6-digit code comparison, waiting, added, and failure states', () => {
    const connectingHtml = renderView({
      discoveryPairing: { host: STUDIO, progress: { state: 'connecting' }, added: false },
    })
    expect(connectingHtml).toContain('Connect to Studio Mac')
    expect(connectingHtml).toContain('Connecting to Studio Mac…')
    expect(connectingHtml).toContain('Cancel')

    const compareHtml = renderView({
      discoveryPairing: {
        host: STUDIO,
        progress: { state: 'compare', code: '482913', matched: false },
        added: false,
      },
    })
    expect(compareHtml).toContain('482')
    expect(compareHtml).toContain('913')
    expect(compareHtml).toContain('Verification code 4 8 2 9 1 3')
    expect(compareHtml).toContain('Codes match')
    expect(compareHtml).toContain('Cancel')

    const waitingHtml = renderView({
      discoveryPairing: {
        host: STUDIO,
        progress: { state: 'compare', code: '482913', matched: true },
        added: false,
      },
    })
    expect(waitingHtml).toContain('482')
    expect(waitingHtml).toContain('913')
    expect(waitingHtml).toContain('Waiting for Studio Mac…')
    expect(waitingHtml).toContain('Chrome · macOS')
    expect(waitingHtml).not.toContain('>Codes match<')

    const addedHtml = renderView({
      discoveryPairing: {
        host: STUDIO,
        progress: { state: 'compare', code: '482913', matched: true },
        added: true,
      },
    })
    expect(addedHtml).toContain('Added. Opening Kettu…')

    const rejectedHtml = renderView({
      discoveryPairing: {
        host: STUDIO,
        progress: { state: 'failed', reason: 'rejected' },
        added: false,
      },
    })
    expect(rejectedHtml).toContain('Studio Mac did not add this browser.')
    expect(rejectedHtml).toContain('>Try again<')
    expect(rejectedHtml).toContain('>Back<')

    const cooldownHtml = renderView({
      discoveryPairing: {
        host: STUDIO,
        progress: { state: 'failed', reason: 'cooling_down' },
        added: false,
      },
    })
    expect(cooldownHtml).toContain('paused for a few minutes')
    expect(cooldownHtml).not.toContain('>Try again<')
    expect(cooldownHtml).toContain('>Back<')
  })

  it('keeps manual link pairing progress, errors, and non-hosted mode intact', () => {
    const busyLinkHtml = renderView({
      progress: { state: 'waiting' },
    })
    expect(busyLinkHtml).toContain('Confirm where the code is shown')
    expect(busyLinkHtml).toContain('Chrome · macOS')
    expect(busyLinkHtml).not.toContain('Computers on your account')

    const failedLinkHtml = renderView({
      discovered: { state: 'ok', hosts: [STUDIO] },
      progress: { state: 'failed', reason: 'void' },
      linkOpen: true,
    })
    expect(failedLinkHtml).toContain('This code no longer works')
    expect(failedLinkHtml).toContain('id="pairing-link"')
    expect(failedLinkHtml).toContain('Studio Mac')

    const directHtml = renderView({ hosted: undefined })
    expect(directHtml).not.toContain('Computers on your account')
    expect(directHtml).not.toContain('Pair with a link instead')
    expect(directHtml).toContain('id="pairing-link"')
    expect(directHtml).toContain('http://…/pair#…')
    expect(directHtml).toContain('Refresh web cache')
  })

  it('offers a direct Refresh web cache action when pairing fails due to an outdated page', () => {
    const discoveryOutdated = renderView({
      discoveryPairing: {
        host: STUDIO,
        progress: { state: 'failed', reason: 'update_client' },
        added: false,
      },
    })
    expect(discoveryOutdated).toContain('This page is older than Kettu on Studio Mac.')
    expect(discoveryOutdated).toContain('Refresh web cache')

    const linkOutdated = renderView({
      hosted: undefined,
      progress: { state: 'failed', reason: 'update_client' },
    })
    expect(linkOutdated).toContain('This page is older than Kettu on the computer.')
    expect(linkOutdated).toContain('Refresh web cache')
  })
})
