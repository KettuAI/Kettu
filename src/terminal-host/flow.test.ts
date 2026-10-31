import { describe, expect, it } from 'vitest'
import { TERMINAL_FLOW } from '@shared/terminal-host'
import { DeviceFlow, FlowControl } from './flow'

describe('FlowControl', () => {
  it('uses the VS Code watermarks by default', () => {
    const flow = new FlowControl()
    expect(flow.sent(['a'], TERMINAL_FLOW.highWatermark)).toBeNull()
    expect(flow.sent(['a'], 1)).toBe('pause')
    expect(flow.ack('a', TERMINAL_FLOW.highWatermark - TERMINAL_FLOW.lowWatermark + 1)).toBeNull()
    expect(flow.ack('a', 1)).toBe('resume')
  })

  it('pauses once above the high watermark and resumes below the low one', () => {
    const flow = new FlowControl(100, 10)
    expect(flow.sent(['a'], 60)).toBeNull()
    expect(flow.sent(['a'], 60)).toBe('pause')
    expect(flow.isPaused).toBe(true)
    expect(flow.sent(['a'], 60)).toBeNull()
    expect(flow.ack('a', 100)).toBeNull()
    expect(flow.ack('a', 75)).toBe('resume')
    expect(flow.isPaused).toBe(false)
  })

  it('waits for the slowest port', () => {
    const flow = new FlowControl(100, 10)
    expect(flow.sent(['fast', 'slow'], 150)).toBe('pause')
    expect(flow.ack('fast', 150)).toBeNull()
    expect(flow.ack('slow', 145)).toBe('resume')
  })

  it('never lets acknowledgements go below zero', () => {
    const flow = new FlowControl(100, 10)
    flow.sent(['a'], 5)
    flow.ack('a', 1000)
    expect(flow.sent(['a'], 101)).toBe('pause')
  })

  it('ignores acknowledgements from unknown ports', () => {
    const flow = new FlowControl(100, 10)
    flow.sent(['a'], 150)
    expect(flow.ack('b', 150)).toBeNull()
    expect(flow.isPaused).toBe(true)
  })

  it('resumes when the port holding it back goes away', () => {
    const flow = new FlowControl(100, 10)
    flow.sent(['a', 'b'], 150)
    flow.ack('a', 150)
    expect(flow.removePort('b')).toBe('resume')
    expect(flow.removePort('b')).toBeNull()
  })
})

describe('DeviceFlow', () => {
  it('stops sending to a port past the high watermark, the one chunk that put it there sent', () => {
    const flow = new DeviceFlow(100, 10)
    expect(flow.sent(['phone'], 60)).toEqual(['phone'])
    expect(flow.sent(['phone'], 60)).toEqual(['phone'])
    expect(flow.sent(['phone'], 60)).toEqual([])
    expect(flow.sent(['phone', 'tablet'], 60)).toEqual(['tablet'])
  })

  it('catches a port up once it acknowledges back under the low watermark', () => {
    const flow = new DeviceFlow(100, 10)
    flow.sent(['phone'], 120)
    flow.sent(['phone'], 50)
    expect(flow.ack('phone', 100)).toBe(false)
    expect(flow.ack('phone', 15)).toBe(true)
    // Caught up: it gets data again, and the next ack is an ordinary one.
    expect(flow.sent(['phone'], 5)).toEqual(['phone'])
    expect(flow.ack('phone', 10)).toBe(false)
  })

  it('never catches up a port that did not fall behind', () => {
    const flow = new DeviceFlow(100, 10)
    flow.sent(['phone'], 90)
    expect(flow.ack('phone', 90)).toBe(false)
    expect(flow.ack('tablet', 90)).toBe(false)
  })

  it('starts a port over after an attach, and forgets one that went away', () => {
    const flow = new DeviceFlow(100, 10)
    flow.sent(['phone', 'tablet'], 150)
    flow.reset('phone')
    expect(flow.sent(['phone', 'tablet'], 10)).toEqual(['phone'])
    flow.removePort('tablet')
    expect(flow.sent(['tablet'], 10)).toEqual(['tablet'])
    expect(flow.ack('tablet', 10)).toBe(false)
  })

  it('uses the same watermarks as the windows by default', () => {
    const flow = new DeviceFlow()
    expect(flow.sent(['phone'], TERMINAL_FLOW.highWatermark)).toEqual(['phone'])
    expect(flow.sent(['phone'], 1)).toEqual(['phone'])
    expect(flow.sent(['phone'], 1)).toEqual([])
    const back = TERMINAL_FLOW.highWatermark + 1 - TERMINAL_FLOW.lowWatermark
    expect(flow.ack('phone', back)).toBe(false)
    expect(flow.ack('phone', 1)).toBe(true)
  })
})
