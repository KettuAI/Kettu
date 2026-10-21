import { describe, expect, it } from 'vitest'
import { ValidationError, validators } from './validate'

describe('terminal request validators', () => {
  it('accepts well-formed requests', () => {
    expect(
      validators['terminals.create']({
        projectPath: '/work/app',
        cols: 80,
        rows: 24,
        command: { text: 'pnpm test\n--watch', run: false },
      }),
    ).toEqual({
      projectPath: '/work/app',
      cols: 80,
      rows: 24,
      command: { text: 'pnpm test\n--watch', run: false },
    })
    expect(validators['terminals.list']({})).toEqual({})
    expect(validators['terminals.list'](undefined)).toEqual({})
    expect(validators['terminals.input']({ id: 't', data: '\x03' })).toEqual({
      id: 't',
      data: '\x03',
    })
    expect(validators['terminals.resize']({ id: 't', cols: 1000, rows: 1 })).toEqual({
      id: 't',
      cols: 1000,
      rows: 1,
    })
    expect(validators['terminals.ack']({ id: 't', chars: 5000 })).toEqual({ id: 't', chars: 5000 })
  })

  it.each([
    ['terminals.create', null],
    ['terminals.create', { projectPath: '/p', cols: 80 }],
    ['terminals.create', { projectPath: '', cols: 80, rows: 24 }],
    ['terminals.create', { projectPath: '/p', cols: 0, rows: 24 }],
    ['terminals.create', { projectPath: '/p', cols: 80, rows: 1001 }],
    ['terminals.create', { projectPath: '/p', cols: 80.5, rows: 24 }],
    ['terminals.create', { projectPath: '/p', cols: 80, rows: 24, shell: '/bin/sh' }],
    ['terminals.create', { projectPath: '/p\0', cols: 80, rows: 24 }],
    ['terminals.create', { projectPath: '/p', cols: 80, rows: 24, command: { text: 'x' } }],
    [
      'terminals.create',
      { projectPath: '/p', cols: 80, rows: 24, command: { text: 'a\x1b[A', run: false } },
    ],
    [
      'terminals.create',
      { projectPath: '/p', cols: 80, rows: 24, command: { text: 'a\rb', run: false } },
    ],
    ['terminals.input', { id: 't', data: 'x'.repeat(64 * 1024 + 1) }],
    ['terminals.input', { id: 't', data: 'é'.repeat(32 * 1024 + 1) }],
    ['terminals.input', { id: 't' }],
    ['terminals.resize', { id: 't', cols: 80, rows: -1 }],
    ['terminals.ack', { id: 't', chars: -1 }],
    ['terminals.kill', { id: '' }],
    ['terminals.kill', { id: 'x'.repeat(200) }],
    ['terminals.attach', 'id'],
  ] as const)('rejects %s %j', (method, params) => {
    expect(() => validators[method](params as never)).toThrow(ValidationError)
  })
})
