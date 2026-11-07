import { describe, expect, it } from 'vitest'
import type { FrameKind } from '@shared/device-host'
import { FrameFanout, type StreamFrame } from './stream'
import { ValidationError, validators } from './validate'

describe('device host request validators', () => {
  it('accepts well-formed requests', () => {
    expect(
      validators['devices.input']({
        deviceId: 'ios-sim:0E02CA7B-60D9-40F6-BCE1-C66A3DECAAEF',
        input: { type: 'touch', phase: 'begin', x: 0.5, y: 0.25, finger: 1 },
      }),
    ).toEqual({
      deviceId: 'ios-sim:0E02CA7B-60D9-40F6-BCE1-C66A3DECAAEF',
      input: { type: 'touch', phase: 'begin', x: 0.5, y: 0.25, finger: 1 },
    })
    expect(validators['devices.open']({ deviceId: 'avd:Pixel_9', sessionId: 's1' })).toEqual({
      deviceId: 'avd:Pixel_9',
      sessionId: 's1',
    })
    expect(
      validators['devices.input']({
        deviceId: 'android:emulator-5554',
        input: { type: 'text', text: '你好\nworld' },
      }).input,
    ).toEqual({ type: 'text', text: '你好\nworld' })
    expect(
      validators['devices.input']({
        deviceId: 'ios-sim:x',
        input: { type: 'frameButton', name: 'volume-up', phase: 'down' },
      }).input,
    ).toEqual({ type: 'frameButton', name: 'volume-up', phase: 'down' })
  })

  it('refuses what is not a device, an input or in range', () => {
    const bad: [keyof typeof validators, unknown][] = [
      ['devices.watch', { deviceId: '/dev/disk0' }],
      ['devices.watch', { deviceId: 'ios-sim:a b' }],
      ['devices.watch', { deviceId: 'ios-sim:x', extra: 1 }],
      [
        'devices.input',
        { deviceId: 'ios-sim:x', input: { type: 'touch', phase: 'begin', x: 2, y: 0 } },
      ],
      ['devices.input', { deviceId: 'ios-sim:x', input: { type: 'button', button: 'shutdown' } }],
      ['devices.input', { deviceId: 'ios-sim:x', input: { type: 'text', text: 'a\u001b[2J' } }],
      [
        'devices.input',
        { deviceId: 'ios-sim:x', input: { type: 'key', phase: 'down', code: 'a;b' } },
      ],
      ['devices.input', { deviceId: 'ios-sim:x', input: { type: 'shell', command: 'ls' } }],
      [
        'devices.input',
        { deviceId: 'ios-sim:x', input: { type: 'frameButton', name: '../x', phase: 'down' } },
      ],
      [
        'devices.input',
        { deviceId: 'ios-sim:x', input: { type: 'frameButton', name: 'power', phase: 'hold' } },
      ],
      [
        'devices.input',
        {
          deviceId: 'ios-sim:x',
          input: { type: 'frameButton', name: 'power', phase: 'up', usage: 48 },
        },
      ],
      ['devices.ack', { deviceId: 'ios-sim:x', seq: -1 }],
      ['devices.close', { deviceId: 'ios-sim:x', sessionId: 's1', shutdown: 'yes' }],
    ]
    for (const [method, params] of bad) {
      expect(() => validators[method](params), `${method} ${JSON.stringify(params)}`).toThrow(
        ValidationError,
      )
    }
  })
})

describe('frame fan-out', () => {
  function setup(window = 3) {
    const sent: Record<string, StreamFrame[]> = {}
    let keyframes = 0
    const fanout = new FrameFanout(
      (port, frame) => (sent[port] ??= []).push(frame),
      () => keyframes++,
      window,
    )
    const push = (kind: FrameKind) => fanout.push(kind, Uint8Array.of(1))
    return { fanout, sent, push, keyframes: () => keyframes }
  }

  it('starts a port at the description and the last keyframe', () => {
    const { fanout, sent, push } = setup()
    push('description')
    push('key')
    push('delta')
    fanout.add('a')
    expect(sent.a!.map((frame) => frame.kind)).toEqual(['description', 'key', 'delta'])
  })

  it('skips a port that falls behind to the next keyframe, and asks for one', () => {
    const { fanout, sent, push, keyframes } = setup(2)
    push('description')
    fanout.add('a')
    push('key')
    push('delta')
    push('delta')
    push('delta')
    expect(sent.a!.map((frame) => frame.kind)).toEqual(['description', 'key', 'delta'])
    expect(keyframes()).toBeGreaterThan(0)
    fanout.ack('a', sent.a!.at(-1)!.seq)
    push('delta')
    push('key')
    expect(sent.a!.map((frame) => frame.kind)).toEqual(['description', 'key', 'delta', 'key'])
  })

  it('ignores acknowledgements of frames it never sent', () => {
    const { fanout, sent, push } = setup(2)
    push('description')
    fanout.add('a')
    push('key')
    fanout.ack('a', 999)
    push('delta')
    push('delta')
    expect(sent.a!.map((frame) => frame.kind)).toEqual(['description', 'key', 'delta'])
  })
})
