import { describe, expect, it } from 'vitest'
import type { TerminalCall } from '@shared/terminal-agent'
import { TerminalArgsError, terminalCallOf, TerminalTools } from './tools'

const context = { agentId: 'claude-code' as const, folder: '/work/app' }

describe('terminal tool arguments', () => {
  it('builds each call for the session', () => {
    expect(terminalCallOf('terminal_run', 's1', { command: 'pnpm dev' }, context)).toEqual({
      kind: 'run',
      sessionId: 's1',
      agentId: 'claude-code',
      folder: '/work/app',
      command: 'pnpm dev',
    })
    expect(terminalCallOf('terminal_read', 's1', { terminalId: 't' }, context)).toEqual({
      kind: 'read',
      sessionId: 's1',
      terminalId: 't',
      lines: 200,
    })
    expect(terminalCallOf('terminal_wait', 's1', { terminalId: 't', lines: 20 }, context)).toEqual({
      kind: 'wait',
      sessionId: 's1',
      terminalId: 't',
      lines: 20,
    })
    expect(terminalCallOf('terminal_input', 's1', { terminalId: 't', text: '' }, context)).toEqual({
      kind: 'input',
      sessionId: 's1',
      terminalId: 't',
      text: '',
      enter: true,
    })
    expect(
      terminalCallOf('terminal_stop', 's1', { terminalId: 't', close: true }, context),
    ).toEqual({ kind: 'stop', sessionId: 's1', terminalId: 't', close: true })
  })

  it('refuses a command that is not one line of plain text', () => {
    for (const command of [
      '',
      '  ',
      'ls\nrm -rf ~',
      'ls\r',
      'ls\x1b[A',
      'a'.repeat(16 * 1024 + 1),
    ]) {
      expect(() => terminalCallOf('terminal_run', 's1', { command }, context)).toThrow(
        TerminalArgsError,
      )
    }
    expect(() =>
      terminalCallOf('terminal_input', 's1', { terminalId: 't', text: 'y\n' }, context),
    ).toThrow(TerminalArgsError)
    expect(() =>
      terminalCallOf('terminal_read', 's1', { terminalId: 't', lines: 2001 }, context),
    ).toThrow(TerminalArgsError)
    expect(() => terminalCallOf('terminal_stop', 's1', { terminalId: 7 }, context)).toThrow(
      TerminalArgsError,
    )
  })

  it('opens no terminal for a session without a folder', () => {
    expect(() =>
      terminalCallOf('terminal_run', 's1', { command: 'ls' }, { ...context, folder: null }),
    ).toThrow(TerminalArgsError)
  })

  it('acts as the session a subagent runs under', async () => {
    const calls: TerminalCall[] = []
    const tools = new TerminalTools({
      call: async (call) => {
        calls.push(call)
        return { result: { kind: 'closed' } }
      },
      sessionOf: (sessionId) => (sessionId === 'sub' ? 'parent' : sessionId),
      agentOf: () => 'codex',
      folderOf: (sessionId) => (sessionId === 'parent' ? '/work/app' : null),
    })
    await tools.call({ sessionId: 'sub', project: '/work/app' }, 'terminal_run', { command: 'ls' })
    expect(calls).toEqual([
      { kind: 'run', sessionId: 'parent', agentId: 'codex', folder: '/work/app', command: 'ls' },
    ])
  })
})
