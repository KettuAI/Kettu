import { describe, expect, it } from 'vitest'
import { Diagnostics, TRAFFIC_MESSAGES } from './diagnostics'

describe('Diagnostics', () => {
  it('keeps the last 2,000 ACP messages per agent with their method and size', () => {
    const diagnostics = new Diagnostics({ now: () => 5 })
    for (let i = 0; i < TRAFFIC_MESSAGES + 10; i++) {
      diagnostics.traffic('fake-agent', 'in', { jsonrpc: '2.0', method: 'session/update', i })
    }
    diagnostics.traffic('codex', 'out', { jsonrpc: '2.0', id: 1, result: {} })
    const fake = diagnostics.agentRecords('fake-agent').traffic
    expect(fake).toHaveLength(TRAFFIC_MESSAGES)
    expect(fake[0]).toMatchObject({ at: 5, direction: 'in', method: 'session/update' })
    expect((fake[0]!.message as { i: number }).i).toBe(10)
    expect(diagnostics.agentRecords('codex').traffic[0]).toMatchObject({
      method: null,
      size: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }).length,
    })
  })

  it('truncates huge messages instead of holding them', () => {
    const diagnostics = new Diagnostics()
    diagnostics.traffic('fake-agent', 'in', { method: 'x', text: 'a'.repeat(600 * 1024) })
    const [record] = diagnostics.agentRecords('fake-agent').traffic
    expect(record!.size).toBeGreaterThan(600 * 1024)
    expect(record!.message).toMatchObject({ truncated: true })
  })

  it('mirrors traffic when asked', () => {
    const lines: string[] = []
    const diagnostics = new Diagnostics({ mirrorTraffic: true, write: (line) => lines.push(line) })
    diagnostics.traffic('opencode', 'out', { method: 'initialize' })
    expect(lines).toEqual(['[acp opencode] -> {"method":"initialize"}'])
  })

  it('keeps stderr, events and the host log', () => {
    const diagnostics = new Diagnostics({ now: () => 9 })
    const seen: string[] = []
    diagnostics.onLog((entry) => seen.push(entry.message))
    diagnostics.stderr('codex', 'line 1\nline 2\n')
    diagnostics.event('codex', 'exit', 'code 1')
    diagnostics.log('warn', 'careful')
    expect(diagnostics.agentRecords('codex')).toMatchObject({
      stderr: 'line 1\nline 2\n',
      events: [{ at: 9, event: 'exit', detail: 'code 1' }],
    })
    expect(diagnostics.logEntries()).toEqual([{ at: 9, level: 'warn', message: 'careful' }])
    expect(seen).toEqual(['careful'])
  })
})
