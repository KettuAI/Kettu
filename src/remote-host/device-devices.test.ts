import { describe, expect, it } from 'vitest'
import { forChannel, isDeviceMethod } from './device-devices'

describe('paired device routing to the device host', () => {
  it('sends only the device host’s own methods there', () => {
    expect(isDeviceMethod('devices.watch')).toBe(true)
    expect(isDeviceMethod('devices.input')).toBe(true)
    // The agent host answers these; the device host would call them unknown.
    expect(isDeviceMethod('devices.answerAccess')).toBe(false)
    expect(isDeviceMethod('devices.allowed')).toBe(false)
    expect(isDeviceMethod('devices.forget')).toBe(false)
    expect(isDeviceMethod('terminals.list')).toBe(false)
  })

  it('carries frames and screenshots as base64', () => {
    const frame = forChannel({
      type: 'event',
      event: {
        type: 'device.frame',
        deviceId: 'ios-sim:x',
        seq: 1,
        kind: 'key',
        data: Uint8Array.of(1, 2, 3).buffer,
      },
    }) as { event: { data: string } }
    expect(frame.event.data).toBe('AQID')
    const shot = forChannel({
      type: 'response',
      id: 4,
      result: { png: Uint8Array.of(255).buffer },
    }) as {
      result: { png: string }
    }
    expect(shot.result.png).toBe('/w==')
  })
})
