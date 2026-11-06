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

  it('carries frames, screenshots and frame pictures as base64', () => {
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
    const framed = forChannel({
      type: 'response',
      id: 5,
      result: {
        frame: {
          width: 1,
          height: 1,
          screen: { x: 0, y: 0, width: 1, height: 1 },
          radii: [0, 0, 0, 0],
          images: [{ x: 0, y: 0, width: 1, height: 1, png: Uint8Array.of(1, 2, 3).buffer }],
        },
      },
    }) as { result: { frame: { images: Array<{ png: string; width: number }> } } }
    expect(framed.result.frame.images[0]).toMatchObject({ png: 'AQID', width: 1 })
  })
})
