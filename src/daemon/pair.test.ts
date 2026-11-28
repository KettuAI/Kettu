import { describe, expect, it } from 'vitest'
import type { ControlClient, ControlEvent, ControlMethod } from './control'
import { deviceLine, pairDevice, type PairTerminal } from './pair'
import { devicesReport, requestReport } from './report'

describe('kettu pair device line formatting', () => {
  it('formats canonical and legacy platform values the same way as Settings', () => {
    expect(
      deviceLine({
        name: 'Phone',
        kind: 'ios',
        model: 'iPhone 17 Pro',
        platform: 'ios',
        known: false,
      }),
    ).toBe('iOS app · iPhone 17 Pro · iOS')
    expect(
      deviceLine({
        name: 'Phone',
        kind: 'ios',
        model: 'iPhone 17 Pro',
        platform: 'iOS 26.1',
        known: false,
      }),
    ).toBe('iOS app · iPhone 17 Pro · iOS 26.1')
    expect(
      deviceLine({
        name: 'Pixel',
        kind: 'android',
        model: 'Pixel 9',
        platform: 'android 15',
        known: false,
      }),
    ).toBe('Android app · Pixel 9 · Android 15')
    expect(
      deviceLine({
        name: 'MacBook',
        kind: 'desktop',
        model: 'MacBook Pro',
        platform: 'macOS 27.0.1',
        known: false,
      }),
    ).toBe('Desktop app · MacBook Pro · macOS 27.0.1')
    expect(
      deviceLine({
        name: 'Chrome',
        kind: 'web',
        model: 'Chrome',
        platform: 'Mac',
        known: false,
      }),
    ).toBe('Web · Chrome · macOS')
    expect(
      deviceLine({
        name: 'Browser',
        kind: 'web',
        model: 'Safari',
        platform: 'web',
        known: false,
      }),
    ).toBe('Web · Safari · Web')
    expect(
      deviceLine({
        name: 'Custom',
        kind: 'desktop',
        model: '',
        platform: '',
        known: false,
      }),
    ).toBe('Desktop app')
  })

  it('prints the formatted platform name in the confirmation prompt', async () => {
    const written: string[] = []
    let onEvent: ((event: ControlEvent) => void) | null = null
    const answers = ['y', '']
    const client: ControlClient = {
      call: async <M extends ControlMethod>(method: M) => {
        if (method === 'pair.open') {
          queueMicrotask(() =>
            onEvent?.({
              type: 'pairing',
              codeId: 1,
              pairing: {
                state: 'confirm',
                device: {
                  name: "Ada's iPhone",
                  kind: 'ios',
                  model: 'iPhone 17 Pro',
                  platform: 'ios',
                  known: false,
                },
              },
            }),
          )
          return { codeId: 1 } as never
        }
        if (method === 'pair.answer') {
          queueMicrotask(() =>
            onEvent?.({
              type: 'pairing',
              codeId: 1,
              pairing: {
                state: 'added',
                device: {
                  id: '0123456789abcdef0123456789abcdef',
                  publicKey: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
                  name: "Ada's iPhone",
                  kind: 'ios',
                  model: 'iPhone 17 Pro',
                  platform: 'ios',
                  addedAt: 1,
                  lastConnectedAt: null,
                  account: null,
                },
              },
            }),
          )
          return null as never
        }
        throw new Error(`Unexpected call: ${method}`)
      },
      onEvent: (listener) => {
        onEvent = listener
      },
      onClose: () => {},
      close: () => {},
    }
    const terminal: PairTerminal = {
      live: false,
      write: (text) => written.push(text),
      ask: async () => answers.shift() ?? null,
    }

    const code = await pairDevice(client, terminal, new AbortController().signal)
    expect(code).toBe(0)
    const output = written.join('')
    expect(output).toContain("Ada's iPhone (iOS app · iPhone 17 Pro · iOS) used the code.")
    expect(output).not.toContain('· ios)')
  })
})

describe('daemon device reports', () => {
  it('formats platform names in kettu devices and kettu requests output', () => {
    const devices = devicesReport(
      [
        {
          id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          name: 'iPhone',
          kind: 'ios',
          platform: 'ios',
          connected: true,
          lastConnectedAt: 1000,
        },
        {
          id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          name: 'Pixel',
          kind: 'android',
          platform: 'android 15',
          connected: false,
          lastConnectedAt: 1000,
        },
        {
          id: 'cccccccccccccccccccccccccccccccc',
          name: 'MacBook',
          kind: 'desktop',
          platform: 'macOS 27.0.1',
          connected: false,
          lastConnectedAt: null,
        },
      ],
      61_000,
    )
    expect(devices).toContain('iPhone   ios      iOS           connected now')
    expect(devices).toContain('Pixel    android  Android 15    1 min ago')
    expect(devices).toContain('MacBook  desktop  macOS 27.0.1  never')

    const request = requestReport(
      {
        added: false,
        event: {
          requestId: 7,
          request: {
            state: 'confirm',
            code: '123456',
            startedAt: 0,
            expiresAt: 120_000,
            deviceConfirmed: false,
            transcript: { hash: 'a', hostNonce: 'b', deviceNonce: 'c' },
            device: {
              name: "Ada's iPhone",
              model: 'iPhone 17',
              kind: 'ios',
              platform: 'ios',
              known: false,
            },
          },
        },
      },
      60_000,
    )
    expect(request).toContain("Ada's iPhone (iPhone 17, iOS) asks to be added to this computer.")
  })
})
