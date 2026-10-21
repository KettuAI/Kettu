import { describe, expect, it } from 'vitest'
import { TERMINAL_FLOW } from '@shared/terminal-host'
import { FlowControl } from './flow'

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
