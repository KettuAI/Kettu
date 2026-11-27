import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaintBoardIcon } from '@hugeicons/core-free-icons'
import { APP_ICONS, DEFAULT_SETTINGS, type AppIcon, type SettingsPatch } from '@shared/settings'
import enSettings from '@shared/locales/en/settings.json'
import zhSettings from '@shared/locales/zh-CN/settings.json'

let mockIsWeb = false
let mockAppIcon: AppIcon = 'kettu'
let capturedOnValueChange: ((next: unknown[]) => void) | undefined
const updateMock = vi.fn<(patch: SettingsPatch) => Promise<void>>(async () => {})

vi.mock('@renderer/lib/platform', () => ({
  get isWeb() {
    return mockIsWeb
  },
  get isHosted() {
    return false
  },
  isMac: true,
  isWindows: false,
  platform: 'darwin',
  formatShortcut: (s: string) => s,
}))

vi.mock('@base-ui/react/toggle-group', () => ({
  ToggleGroup: ({
    value,
    onValueChange,
    children,
    ...rest
  }: {
    value?: unknown[]
    onValueChange?: (next: unknown[]) => void
    children?: ReactNode
  }) => {
    capturedOnValueChange = onValueChange
    return createElement(
      'div',
      { role: 'group', 'data-selected': String(value?.[0] ?? ''), ...rest },
      children,
    )
  },
}))

vi.mock('@base-ui/react/toggle', () => ({
  Toggle: ({
    value,
    children,
    ...rest
  }: {
    value: string
    children?: ReactNode
    className?: string
  }) =>
    createElement(
      'button',
      {
        type: 'button',
        'aria-pressed': value === mockAppIcon ? 'true' : 'false',
        'data-value': value,
        ...rest,
      },
      children,
    ),
}))

vi.mock('@renderer/components/affect/app-shell', () => ({
  Icon: () => createElement('span', { 'data-testid': 'check-icon' }),
}))

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string) => {
      const parts = key.split('.')
      let cur: unknown = enSettings
      for (const part of parts) {
        if (typeof cur !== 'object' || cur === null || !(part in cur)) return key
        cur = (cur as Record<string, unknown>)[part]
      }
      return typeof cur === 'string' ? cur : key
    },
  }),
}))

vi.mock('@renderer/stores/host-scope', () => ({
  useHostScope: () => ({
    useSettingsStore: Object.assign(
      <T>(selector: (state: { settings: typeof DEFAULT_SETTINGS }) => T): T =>
        selector({
          settings: {
            ...DEFAULT_SETTINGS,
            appearance: { ...DEFAULT_SETTINGS.appearance, appIcon: mockAppIcon },
          },
        }),
      {
        getState: () => ({
          update: updateMock,
        }),
      },
    ),
  }),
}))

vi.mock('@renderer/stores/settings-store', () => ({
  useSettingsStore: <T>(selector: (state: { settings: typeof DEFAULT_SETTINGS }) => T): T =>
    selector({
      settings: {
        ...DEFAULT_SETTINGS,
        appearance: { ...DEFAULT_SETTINGS.appearance, appIcon: mockAppIcon },
      },
    }),
}))

import { BrandIcon } from '@renderer/components/brand'
import { appIconUrl } from '@renderer/lib/app-icons'
import { AppIconTiles } from './app-icon-section'
import type { SectionDef } from './model'
import { webClusters } from './web-sections'

describe('AppIconTiles', () => {
  beforeEach(() => {
    mockIsWeb = false
    mockAppIcon = 'kettu'
    capturedOnValueChange = undefined
    updateMock.mockClear()
  })

  it('renders all six app icons with labels, previews and selected state', () => {
    mockAppIcon = 'ink-sheets'
    const html = renderToStaticMarkup(createElement(AppIconTiles))

    for (const icon of APP_ICONS) {
      expect(html).toContain(`data-app-icon="${icon}"`)
      expect(html).toContain(enSettings.appearance.appIcon.options[icon])
      expect(html).toContain(`src="${appIconUrl(icon)}"`)
    }
    expect(html).toContain('data-selected="ink-sheets"')
    expect(html).toContain('aria-pressed="true" data-value="ink-sheets"')
    expect(html).toContain('data-testid="check-icon"')
  })

  it('dispatches a settings update when switching to a different icon and ignores no-op clicks', () => {
    mockAppIcon = 'kettu'
    renderToStaticMarkup(createElement(AppIconTiles))

    capturedOnValueChange?.(['kettu'])
    expect(updateMock).not.toHaveBeenCalled()

    capturedOnValueChange?.(['paper'])
    expect(updateMock).toHaveBeenCalledTimes(1)
    expect(updateMock).toHaveBeenCalledWith({ appearance: { appIcon: 'paper' } })
  })

  it('hides the desktop app icon picker in the web client', () => {
    mockIsWeb = true
    expect(renderToStaticMarkup(createElement(AppIconTiles))).toBe('')

    const appearance: SectionDef = {
      id: 'appearance',
      title: 'Appearance',
      description: 'Look and feel',
      icon: PaintBoardIcon,
      rows: [
        { id: 'theme', setting: 'appearance.theme', render: () => null },
        { id: 'app-icon', setting: 'appearance.app-icon', render: () => null },
        { id: 'zoom', setting: 'appearance.zoom', render: () => null },
        { id: 'text-size', setting: 'appearance.text-size', render: () => null },
      ],
    }
    const filtered = webClusters([[appearance]])
    expect(filtered[0]?.[0]?.rows.map((row) => row.id)).toEqual(['theme', 'text-size'])
  })
})

describe('BrandIcon synchronization and bilingual labels', () => {
  beforeEach(() => {
    mockIsWeb = false
    mockAppIcon = 'kettu'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('follows the selected desktop app icon unless pinned or running in web', () => {
    mockAppIcon = 'orange-flat'
    const desktopHtml = renderToStaticMarkup(createElement(BrandIcon, { size: 48 }))
    expect(desktopHtml).toContain(`src="${appIconUrl('orange-flat')}"`)

    const pinnedHtml = renderToStaticMarkup(createElement(BrandIcon, { size: 40, icon: 'kettu' }))
    expect(pinnedHtml).toContain(`src="${appIconUrl('kettu')}"`)

    vi.stubGlobal('window', { kettu: { client: 'web' } })
    const webHtml = renderToStaticMarkup(createElement(BrandIcon, { size: 48 }))
    expect(webHtml).toContain(`src="${appIconUrl('kettu')}"`)
  })

  it('keeps English and Simplified Chinese labels aligned for all six icons', () => {
    expect(enSettings.appearance.appIcon.options).toEqual({
      kettu: 'Kettu',
      ink: 'Ink',
      paper: 'Paper',
      'orange-flat': 'Orange Flat',
      'ink-sheets': 'Ink Sheets',
      'paper-sheets': 'Paper Sheets',
    })
    expect(zhSettings.appearance.appIcon.options).toEqual({
      kettu: 'Kettu',
      ink: '墨黑',
      paper: '素纸',
      'orange-flat': '扁平橙',
      'ink-sheets': '叠纸黑',
      'paper-sheets': '叠纸白',
    })
  })
})
