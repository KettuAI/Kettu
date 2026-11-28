import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import enSettings from '@shared/locales/en/settings.json'
import zhSettings from '@shared/locales/zh-CN/settings.json'
import type { AppInfo } from '@shared/ipc'
import type { WebClientMode } from '@renderer/lib/platform'

const webHostState = vi.hoisted((): { host: { name: string } | null } => ({ host: null }))

const platformState = vi.hoisted(
  (): {
    platform: 'darwin'
    isWeb: boolean
    isHosted: boolean
    isRelayPage: boolean
    isMac: boolean
    isWindows: boolean
    webMode: WebClientMode | null
    webVersion: string | null
    formatShortcut: (shortcut: string) => string
  } => ({
    platform: 'darwin',
    isWeb: false,
    isHosted: false,
    isRelayPage: false,
    isMac: true,
    isWindows: false,
    webMode: null,
    webVersion: null,
    formatShortcut: (shortcut) => shortcut,
  }),
)

vi.mock('@renderer/lib/platform', () => ({
  get platform() {
    return platformState.platform
  },
  get isWeb() {
    return platformState.isWeb
  },
  get isHosted() {
    return platformState.isHosted
  },
  get isRelayPage() {
    return platformState.isRelayPage
  },
  get isMac() {
    return platformState.isMac
  },
  get isWindows() {
    return platformState.isWindows
  },
  get webMode() {
    return platformState.webMode
  },
  get webVersion() {
    return platformState.webVersion
  },
  formatShortcut: (shortcut: string) => platformState.formatShortcut(shortcut),
}))

vi.mock('@renderer/features/github-star/star-prompts', () => ({
  AboutStarButton: () => null,
}))

vi.mock('@renderer/stores/web-host', () => ({
  useWebHostStore: <T>(selector: (state: { host: { name: string } | null }) => T): T =>
    selector(webHostState),
}))

import { AboutHero, RefreshWebCache } from './about-section'
import { CATALOG } from '@shared/settings-catalog'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const i18n = i18next.createInstance()

const HOST_INFO: AppInfo = {
  name: 'Kettu',
  version: '0.1.25',
  system: 'macOS 15.4 (arm64)',
  userDataPath: '/tmp/kettu',
  isPackaged: true,
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    defaultNS: 'settings',
    ns: ['settings'],
    resources: { en: { settings: enSettings }, 'zh-CN': { settings: zhSettings } },
    interpolation: { escapeValue: false },
  })
})

beforeEach(() => {
  platformState.isWeb = false
  platformState.isHosted = false
  platformState.isRelayPage = false
  platformState.webMode = null
  platformState.webVersion = null
  webHostState.host = null
})

function renderHero(info: AppInfo | null = HOST_INFO, lng: 'en' | 'zh-CN' = 'en'): string {
  void i18n.changeLanguage(lng)
  return renderToStaticMarkup(
    createElement(I18nextProvider, { i18n }, createElement(AboutHero, { info })),
  )
}

describe('AboutHero desktop vs web version display', () => {
  it('shows only the desktop app version line when not running in the web client', () => {
    const html = renderHero()
    expect(html).toContain('Version 0.1.25 · macOS 15.4 (arm64)')
    expect(html).not.toContain('Web client')
    expect(html).not.toContain('Host ·')
  })

  it.each<[WebClientMode, string, string]>([
    ['hosted', 'Hosted', 'Kettu 托管'],
    ['relay', 'Relay', '自建中继'],
    ['direct', 'Direct', '直连'],
  ])(
    'distinguishes web client version (%s) from connected host version',
    (mode, enLabel, zhLabel) => {
      platformState.isWeb = true
      platformState.isHosted = mode === 'hosted'
      platformState.isRelayPage = mode === 'relay'
      platformState.webMode = mode
      platformState.webVersion = '0.1.24'
      webHostState.host = { name: 'Studio Mac' }

      const enHtml = renderHero(HOST_INFO, 'en')
      expect(enHtml).toContain(`Web client 0.1.24 · ${enLabel}`)
      expect(enHtml).toContain('Studio Mac · Version 0.1.25 · macOS 15.4 (arm64)')

      const zhHtml = renderHero(HOST_INFO, 'zh-CN')
      expect(zhHtml).toContain(`网页客户端 0.1.24 · ${zhLabel}`)
      expect(zhHtml).toContain('Studio Mac · 版本 0.1.25 · macOS 15.4 (arm64)')
    },
  )

  it('shows a generic Host label when host name is not yet known in web mode', () => {
    platformState.isWeb = true
    platformState.webMode = 'direct'
    platformState.webVersion = '0.1.25'

    const html = renderHero(HOST_INFO, 'en')
    expect(html).toContain('Web client 0.1.25 · Direct')
    expect(html).toContain('Host · Version 0.1.25 · macOS 15.4 (arm64)')
  })
})

describe('RefreshWebCache control', () => {
  it('renders localized Refresh web cache button copy', () => {
    void i18n.changeLanguage('en')
    const enHtml = renderToStaticMarkup(
      createElement(I18nextProvider, { i18n }, createElement(RefreshWebCache)),
    )
    expect(enHtml).toContain('Refresh web cache')

    void i18n.changeLanguage('zh-CN')
    const zhHtml = renderToStaticMarkup(
      createElement(I18nextProvider, { i18n }, createElement(RefreshWebCache)),
    )
    expect(zhHtml).toContain('刷新网页缓存')
  })

  it('registers about.web-cache as browser-only in catalog and guards it behind isWeb in About', () => {
    const entry = CATALOG['about.web-cache']
    expect(entry.section).toBe('about')
    expect(entry.row).toBe('web-cache')
    expect(entry.kind).toBe('action')
    expect(entry.on?.({} as never, null)).toBe(false)

    const sectionDefs = readFileSync(
      fileURLToPath(new URL('./section-defs.tsx', import.meta.url)),
      'utf8',
    )
    expect(sectionDefs).toContain("setting: 'about.web-cache'")
    expect(sectionDefs).toMatch(/isWeb\s*\?\s*\(\[\s*\{\s*id:\s*'web-cache'/)
  })
})
