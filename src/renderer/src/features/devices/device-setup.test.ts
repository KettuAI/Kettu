import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { DeviceEnvironment, DeviceInfo, DeviceProblem } from '@shared/device-host'
import enDevices from '@shared/locales/en/devices.json'
import zhDevices from '@shared/locales/zh-CN/devices.json'

const localeState = vi.hoisted(() => ({
  catalog: {} as Record<string, unknown>,
}))

function lookup(catalog: Record<string, unknown>, key: string): string {
  const value = key.split('.').reduce<unknown>((current, part) => {
    if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
      return (current as Record<string, unknown>)[part]
    }
    return undefined
  }, catalog)
  return typeof value === 'string' ? value : key
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string>) => {
      let text = lookup(localeState.catalog, key)
      for (const [name, value] of Object.entries(vars ?? {})) {
        text = text.replaceAll(`{{${name}}}`, value)
      }
      return text
    },
  }),
}))

import { DeviceSetup } from './device-setup'

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = []
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      keys.push(...flattenKeys(value as Record<string, unknown>, full))
    } else {
      keys.push(full)
    }
  }
  return keys.sort()
}

const MAC_ENV: DeviceEnvironment = {
  platform: 'darwin',
  ios: true,
  iosStream: true,
  android: true,
  problems: [],
}

function physicalIphone(problems: DeviceProblem[]): DeviceInfo {
  return {
    id: 'ios:00008150-000125C03AE2401C',
    platform: 'ios',
    kind: 'physical',
    name: 'My iPhone',
    osVersion: '26.3.1',
    model: 'iPhone Air',
    state: 'connected',
    connection: 'usb',
    sessionId: 's1',
    operator: null,
    problems,
    input: false,
    bootedByHost: false,
  }
}

describe('DeviceSetup physical iPhone prerequisites', () => {
  it('renders all seven physical iPhone checks in order and keeps simulators and Android separate', () => {
    localeState.catalog = enDevices
    const physicalHtml = renderToStaticMarkup(
      createElement(DeviceSetup, {
        device: physicalIphone([
          'usb-required',
          'not-paired',
          'developer-mode-off',
          'ddi-not-mounted',
          'runner-unsigned',
          'runner-untrusted',
          'ui-automation-off',
        ]),
        environment: MAC_ENV,
      }),
    )
    const labels = [
      'Connect with a cable',
      'Trust this computer',
      'Developer Mode',
      'Developer disk image',
      'Sign the runner',
      'Trust the developer',
      'Enable UI Automation',
    ]
    const offsets = labels.map((label) => physicalHtml.indexOf(label))
    expect(offsets.every((offset) => offset >= 0)).toBe(true)
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b))

    const simulatorHtml = renderToStaticMarkup(
      createElement(DeviceSetup, {
        device: {
          ...physicalIphone([]),
          id: 'ios-sim:0E02CA7B-60D9-40F6-BCE1-C66A3DECAAEF',
          kind: 'simulator',
          name: 'iPhone 17',
        },
        environment: MAC_ENV,
      }),
    )
    expect(simulatorHtml).not.toContain('Sign the runner')
    expect(simulatorHtml).not.toContain('Trust the developer')
    expect(simulatorHtml).not.toContain('Enable UI Automation')

    const androidHtml = renderToStaticMarkup(
      createElement(DeviceSetup, {
        device: {
          ...physicalIphone(['usb-debugging-unauthorized']),
          id: 'android:R58M123456A',
          platform: 'android',
          name: 'Pixel 9',
        },
        environment: MAC_ENV,
      }),
    )
    expect(androidHtml).toContain('Connection')
    expect(androidHtml).toContain('USB debugging')
    expect(androidHtml).not.toContain('Sign the runner')
  })

  it('renders runner signing, developer trust and UI Automation steps in English', () => {
    localeState.catalog = enDevices
    const html = renderToStaticMarkup(
      createElement(DeviceSetup, {
        device: physicalIphone(['runner-unsigned', 'runner-untrusted', 'ui-automation-off']),
        environment: MAC_ENV,
      }),
    )
    expect(html).toContain('Sign the runner')
    expect(html).toContain(enDevices.setup.check['runner-unsigned'].todo)
    expect(html).toContain('Trust the developer')
    expect(html).toContain(enDevices.setup.check['runner-untrusted'].todo.replaceAll('&', '&amp;'))
    expect(html).toContain('Enable UI Automation')
    expect(html).toContain(enDevices.setup.check['ui-automation-off'].todo)
    expect(html).toContain('data-state="current"')
    expect(html).toContain('data-state="locked"')
    // 1 host check done + 4 device checks done out of 8 total.
    expect(html).toContain('5/8')
  })

  it('renders localized steps in Simplified Chinese and marks completed prerequisites done', () => {
    localeState.catalog = zhDevices
    const html = renderToStaticMarkup(
      createElement(DeviceSetup, {
        device: physicalIphone(['ui-automation-off']),
        environment: MAC_ENV,
      }),
    )
    expect(html).toContain(zhDevices.setup.check['runner-unsigned'].label)
    expect(html).toContain(zhDevices.setup.check['runner-unsigned'].done)
    expect(html).toContain(zhDevices.setup.check['runner-untrusted'].label)
    expect(html).toContain(zhDevices.setup.check['runner-untrusted'].done)
    expect(html).toContain(zhDevices.setup.check['ui-automation-off'].label)
    expect(html).toContain(zhDevices.setup.check['ui-automation-off'].todo)
    // 1 host check + 6 device checks done out of 8 total.
    expect(html).toContain('7/8')
  })

  it('keeps en and zh-CN devices locale keys in sync', () => {
    expect(flattenKeys(zhDevices)).toEqual(flattenKeys(enDevices))
  })
})
