import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import enSettings from '@shared/locales/en/settings.json'
import type { HostLoad } from '@shared/host-load'
import type { HostStatus } from '@shared/remote/hosts'
import { wattsText } from './host-load-text'

let mockedLive: { load: HostLoad; recent: { at: number; cpu: number }[] } | null = null

vi.mock('@renderer/lib/platform', () => ({
  platform: 'darwin',
  isMac: true,
  isWindows: false,
  isRelayPage: false,
  isWeb: false,
}))

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, params?: Record<string, unknown>) => {
        const resolved = key.split('.').reduce<unknown>((current, part) => {
          if (
            current &&
            typeof current === 'object' &&
            part in (current as Record<string, unknown>)
          ) {
            return (current as Record<string, unknown>)[part]
          }
          return undefined
        }, enSettings)
        if (typeof resolved !== 'string') return key
        return resolved.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params?.[name] ?? ''))
      },
    }),
  }
})

vi.mock('@renderer/stores/host-load', () => ({
  useHostLoadStore: () => false,
  useLiveLoad: () => mockedLive,
  useLoadUnsupported: () => false,
  useLoadWatch: () => {},
}))

import { HostLoadGroup } from './host-load'

const HOST = {
  id: 'host-1',
  name: 'Studio Mac',
  platform: 'darwin',
  version: '0.1.25',
  connection: { state: 'online', address: { host: '127.0.0.1', port: 4000 }, terminal: true },
} as HostStatus

const BASE_LOAD: HostLoad = {
  at: 1_800_000_000_000,
  cpu: { percent: 18, cores: 10 },
  memory: { used: 8e9, total: 32e9, state: 'plenty' },
}

describe('wattsText', () => {
  it('formats watts with at most one decimal place and no trailing .0', () => {
    expect(wattsText(10.34)).toBe('10.3 W')
    expect(wattsText(30)).toBe('30 W')
    expect(wattsText(0)).toBe('0 W')
    expect(wattsText(-0.01)).toBe('0 W')
  })
})

describe('HostLoadGroup power header', () => {
  it('shows whole-system watts in the Load header with breakdown in the tooltip', () => {
    mockedLive = {
      load: {
        ...BASE_LOAD,
        power: {
          systemWatts: 12.3,
          cpuWatts: null,
          batteryWatts: 30,
          batteryState: 'charging',
        },
      },
      recent: [],
    }
    const html = renderToStaticMarkup(createElement(HostLoadGroup, { host: HOST }))
    expect(html).toContain('aria-label="Power 12.3 W"')
    expect(html).toContain('title="System 12.3 W · Battery charging 30 W"')
    expect(html).toContain('>12.3 W<')
  })

  it('explicitly labels CPU-only power readings as CPU in the Load header', () => {
    mockedLive = {
      load: {
        ...BASE_LOAD,
        power: {
          systemWatts: null,
          cpuWatts: 15.2,
          batteryWatts: null,
        },
      },
      recent: [],
    }
    const html = renderToStaticMarkup(createElement(HostLoadGroup, { host: HOST }))
    expect(html).toContain('aria-label="CPU power 15.2 W"')
    expect(html).toContain('>CPU 15.2 W<')
  })

  it('hides the header power item when only battery power or no power reading is available', () => {
    mockedLive = {
      load: {
        ...BASE_LOAD,
        power: {
          systemWatts: null,
          cpuWatts: null,
          batteryWatts: 14.5,
          batteryState: 'discharging',
        },
      },
      recent: [],
    }
    const batteryOnlyHtml = renderToStaticMarkup(createElement(HostLoadGroup, { host: HOST }))
    expect(batteryOnlyHtml).not.toContain('k-load-power')

    mockedLive = { load: BASE_LOAD, recent: [] }
    const noPowerHtml = renderToStaticMarkup(createElement(HostLoadGroup, { host: HOST }))
    expect(noPowerHtml).not.toContain('k-load-power')
  })
})
