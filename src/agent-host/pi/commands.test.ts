// Pi's slash commands as a session offers them, and the ones Kettu runs through pi's RPC.

import { describe, expect, it } from 'vitest'
import { autoCompactWord, commandList, parseCommand, queueMode, statsMessage } from './commands'
import { NAVIGATE_COMMAND } from './extension'

describe("Pi's commands", () => {
  it("lists pi's own first, then Kettu's for pi, each name once", () => {
    const list = commandList([
      { name: 'skill:lint', description: ' Lint the code ', source: 'skill' },
      {
        name: NAVIGATE_COMMAND,
        description: 'Internal Kettu session tree navigation',
        source: 'extension',
      },
      { name: 'mcp', source: 'extension' },
      { name: 'compact', description: 'A template named compact', source: 'prompt' },
      { name: '', source: 'prompt' },
    ])
    expect(list.some((command) => command.name === NAVIGATE_COMMAND)).toBe(false)
    expect(list.slice(0, 3)).toEqual([
      { name: 'skill:lint', description: 'Lint the code', kind: 'skill' },
      { name: 'mcp', description: '(extension)' },
      { name: 'compact', description: 'A template named compact' },
    ])
    expect(list.map((command) => command.name).slice(3)).toEqual([
      'autocompact',
      'export',
      'session',
      'name',
      'steering',
      'follow-up',
      'changelog',
    ])
    expect(list.find((command) => command.name === 'name')?.inputHint).toBeTruthy()
    expect(list.find((command) => command.name === 'export')?.inputHint).toBeUndefined()
  })

  it('reads only its own commands from a prompt', () => {
    expect(parseCommand(' /name  Refactor auth ')).toEqual({ name: 'name', rest: 'Refactor auth' })
    expect(parseCommand('/compact')).toEqual({ name: 'compact', rest: '' })
    expect(parseCommand('/follow-up all')).toEqual({ name: 'follow-up', rest: 'all' })
    expect(parseCommand('/skill:lint src')).toBeNull()
    expect(parseCommand('/names')).toBeNull()
    expect(parseCommand('compact this')).toBeNull()
  })

  it('reads the words its commands take', () => {
    expect(autoCompactWord('ON')).toBe(true)
    expect(autoCompactWord('disable')).toBe(false)
    expect(autoCompactWord('')).toBeNull()
    expect(queueMode('All')).toBe('all')
    expect(queueMode('one-at-a-time')).toBe('one-at-a-time')
    expect(queueMode('some')).toBeNull()
  })

  it("writes a session's statistics as lines", () => {
    const text = statsMessage({
      sessionId: 'abc',
      totalMessages: 14,
      cost: 0.0015,
      tokens: { input: 12886, output: 64, cacheRead: 18176, cacheWrite: 0, total: 31126 },
    })
    expect(text.split('  \n')).toEqual([
      '**Session:** `abc`',
      '**Messages:** 14',
      '**Cost:** $0.0015',
      '**Tokens:** 12886 input, 64 output, 18176 cache read, 0 cache write, 31126 total',
    ])
  })
})
