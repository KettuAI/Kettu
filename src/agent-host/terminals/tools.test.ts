import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONTROL_WAIT_MS, type SurfaceAccessAnswer } from '@shared/control'
import type { AgentTerminal, TerminalCall, TerminalCallAnswer } from '@shared/terminal-agent'
import {
  TERMINAL_TOOLS,
  TerminalArgsError,
  terminalCallOf,
  TerminalTools,
  type TerminalToolDeps,
} from './tools'

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
      accessOf: () => ({ fullAccess: false, planning: false }),
      ask: async () => 'deny',
      used: () => undefined,
      shared: () => false,
    })
    await tools.call({ sessionId: 'sub', project: '/work/app' }, 'terminal_run', { command: 'ls' })
    expect(calls).toEqual([
      { kind: 'run', sessionId: 'parent', agentId: 'codex', folder: '/work/app', command: 'ls' },
    ])
  })
})

const USER_TERMINAL: AgentTerminal = {
  id: 't1',
  title: 'pnpm dev',
  name: null,
  namedBy: null,
  busy: true,
  exitCode: null,
  password: false,
  opener: 'user',
  usable: false,
}

/**
 * A terminal host where `t1` is the user's terminal of session s1, which reads `ask` until an
 * allow for it comes, and the tools over it.
 */
function userTerminal(deps: Partial<TerminalToolDeps> = {}) {
  const calls: TerminalCall[] = []
  let allowed = false
  const ask = vi.fn<TerminalToolDeps['ask']>(async () => 'allow')
  const used = vi.fn<TerminalToolDeps['used']>()
  const tools = new TerminalTools({
    call: async (call): Promise<TerminalCallAnswer> => {
      calls.push(call)
      if (call.kind === 'allow') {
        allowed = call.allowed
        return { result: { kind: 'terminal', terminal: { ...USER_TERMINAL, usable: allowed } } }
      }
      if (call.kind === 'asking') return { result: { kind: 'terminal', terminal: USER_TERMINAL } }
      if (call.kind === 'rename') {
        if (!call.asked) return { result: { kind: 'ask', terminal: USER_TERMINAL } }
        return { result: { kind: 'terminal', terminal: { ...USER_TERMINAL, name: call.name } } }
      }
      if (!allowed) return { result: { kind: 'ask', terminal: USER_TERMINAL } }
      return {
        result: { kind: 'output', terminal: { ...USER_TERMINAL, usable: true }, output: 'ok' },
      }
    },
    sessionOf: (sessionId) => sessionId,
    agentOf: () => 'claude-code',
    folderOf: () => '/work/app',
    accessOf: () => ({ fullAccess: false, planning: false }),
    ask,
    used,
    shared: () => false,
    ...deps,
  })
  const read = () =>
    tools.call({ sessionId: 's1', project: '/work/app' }, 'terminal_read', { terminalId: 't1' })
  return { tools, calls, ask, used, read }
}

const kinds = (calls: TerminalCall[]) =>
  calls.map((call) => (call.kind === 'asking' ? `asking:${call.asking}` : call.kind))

describe('an agent using a terminal the user opened', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('asks the user, gives the allow and then runs the call', async () => {
    const { calls, ask, read } = userTerminal()
    const result = await read()
    expect(ask).toHaveBeenCalledWith('s1', USER_TERMINAL, { readOnly: false })
    expect(kinds(calls)).toEqual(['read', 'asking:true', 'allow', 'read'])
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({ output: 'ok' })
  })

  it('fails without acting when the user denies it', async () => {
    const { calls, read } = userTerminal({ ask: async () => 'deny' })
    const result = await read()
    expect(result).toMatchObject({ isError: true, structuredContent: { code: 'not_allowed' } })
    expect(kinds(calls)).toEqual(['read', 'asking:true', 'asking:false'])
  })

  it('asks nothing in full access, and the thread says it used it', async () => {
    const { calls, ask, used, read } = userTerminal({
      accessOf: () => ({ fullAccess: true, planning: false }),
    })
    await read()
    expect(ask).not.toHaveBeenCalled()
    expect(used).toHaveBeenCalledWith('s1', USER_TERMINAL)
    expect(kinds(calls)).toEqual(['read', 'allow', 'read'])
  })

  it('asks nothing for a terminal the user referenced in a message', async () => {
    const { calls, ask, used, read } = userTerminal({ shared: () => true })
    await read()
    expect(ask).not.toHaveBeenCalled()
    expect(used).not.toHaveBeenCalled()
    expect(kinds(calls)).toEqual(['read', 'allow', 'read'])
  })

  it('returns to be called again while the user decides, and asks once', async () => {
    let answer: (value: SurfaceAccessAnswer) => void = () => undefined
    const ask = vi.fn<TerminalToolDeps['ask']>(() => new Promise((resolve) => (answer = resolve)))
    const { calls, read } = userTerminal({ ask })
    const first = read()
    await vi.advanceTimersByTimeAsync(CONTROL_WAIT_MS)
    expect(await first).toMatchObject({ structuredContent: { asking: true } })
    const second = read()
    await vi.advanceTimersByTimeAsync(0)
    answer('allow')
    expect((await second).structuredContent).toMatchObject({ output: 'ok' })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(kinds(calls)).toEqual(['read', 'asking:true', 'read', 'allow', 'read'])
  })

  it('types into it only while the session does not plan', () => {
    const typing = { terminalId: 't1', text: 'ls' }
    expect(terminalCallOf('terminal_input', 's1', typing, { ...context, planning: true })).toEqual({
      kind: 'input',
      sessionId: 's1',
      terminalId: 't1',
      text: 'ls',
      enter: true,
      readOnly: true,
    })
    expect(terminalCallOf('terminal_input', 's1', typing, context)).not.toHaveProperty('readOnly')
  })
})

describe('an agent renaming a terminal', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const caller = { sessionId: 's1', project: '/work/app' }

  it("asks before it renames the user's, then renames it this once", async () => {
    const { tools, calls, ask } = userTerminal()
    const result = await tools.call(caller, 'terminal_rename', { terminalId: 't1', name: 'Deploy' })
    expect(ask).toHaveBeenCalledWith('s1', USER_TERMINAL, { readOnly: false, rename: 'Deploy' })
    expect(result.structuredContent).toMatchObject({ terminal: { name: 'Deploy' } })
    expect(kinds(calls)).toEqual(['rename', 'asking:true', 'asking:false', 'rename'])
    expect(calls.filter((call) => call.kind === 'allow')).toEqual([])
  })

  it('keeps the name when the user says no', async () => {
    const { tools, calls } = userTerminal({ ask: async () => 'deny' })
    const result = await tools.call(caller, 'terminal_rename', { terminalId: 't1', name: 'Deploy' })
    expect(result).toMatchObject({ isError: true, structuredContent: { code: 'not_allowed' } })
    expect(kinds(calls)).toEqual(['rename', 'asking:true', 'asking:false'])
  })

  it('renames at once when the user asked for it, or the mode asks nothing', async () => {
    const asked = userTerminal()
    await asked.tools.call(caller, 'terminal_rename', {
      terminalId: 't1',
      name: 'Deploy',
      userAsked: true,
    })
    expect(asked.ask).not.toHaveBeenCalled()
    expect(asked.calls).toEqual([
      { kind: 'rename', sessionId: 's1', terminalId: 't1', name: 'Deploy', asked: true },
    ])
    const full = userTerminal({ accessOf: () => ({ fullAccess: true, planning: false }) })
    await full.tools.call(caller, 'terminal_rename', { terminalId: 't1', name: 'Deploy' })
    expect(full.ask).not.toHaveBeenCalled()
    expect(kinds(full.calls)).toEqual(['rename'])
  })

  it('takes one line of at most 40 characters as a name, and empty to go back', () => {
    const call = (name: unknown) =>
      terminalCallOf('terminal_rename', 's1', { terminalId: 't1', name }, context)
    expect(call('  Deploy  ')).toMatchObject({ name: 'Deploy', asked: false })
    expect(call('')).toMatchObject({ name: '' })
    expect(() => call('x'.repeat(41))).toThrow(TerminalArgsError)
    expect(() => call('a\nb')).toThrow(TerminalArgsError)
    expect(() => call(7)).toThrow(TerminalArgsError)
    expect(
      terminalCallOf('terminal_run', 's1', { command: 'pnpm dev', name: 'Dev server' }, context),
    ).toMatchObject({ kind: 'run', name: 'Dev server' })
  })
})

describe('passwords in the terminal tools', () => {
  const PROMPT: AgentTerminal = { ...USER_TERMINAL, opener: 'agent', usable: true, password: true }

  function tools(passwords: boolean) {
    const calls: TerminalCall[] = []
    const terminalTools = new TerminalTools({
      call: async (call) => {
        calls.push(call)
        return { result: { kind: 'terminal', terminal: PROMPT } }
      },
      sessionOf: (sessionId) => sessionId,
      agentOf: () => 'codex',
      folderOf: () => '/work/app',
      accessOf: () => ({ fullAccess: false, planning: false }),
      ask: async () => 'deny',
      used: () => undefined,
      shared: () => false,
      passwords: () => passwords,
    })
    return { calls, terminalTools }
  }
  const caller = { sessionId: 's1', project: '/work/app' }
  const text = (result: CallToolResult) =>
    result.content.map((part) => ('text' in part ? part.text : '')).join('')

  it('leaves them to the user by default', async () => {
    const { calls, terminalTools } = tools(false)
    const typed = await terminalTools.call(caller, 'terminal_input', {
      terminalId: 't1',
      text: 'x',
    })
    await terminalTools.call(caller, 'terminal_stop', { terminalId: 't1' })
    expect(calls.map((call) => 'passwords' in call)).toEqual([false, false])
    expect(text(typed)).toContain(
      'waits for the user to type a password in it; ask them to, then call terminal_wait',
    )
    const input = TERMINAL_TOOLS.find((tool) => tool.name === 'terminal_input')!
    expect(input.description).toContain('Never types a password: only the user does.')
    expect(terminalTools.listed(TERMINAL_TOOLS)).toBe(TERMINAL_TOOLS)
  })

  it('says with each input and stop that the user lets agents type them', async () => {
    const { calls, terminalTools } = tools(true)
    const typed = await terminalTools.call(caller, 'terminal_input', {
      terminalId: 't1',
      text: 'x',
    })
    await terminalTools.call(caller, 'terminal_stop', { terminalId: 't1' })
    await terminalTools.call(caller, 'terminal_read', { terminalId: 't1' })
    expect(calls).toMatchObject([
      { kind: 'input', passwords: true },
      { kind: 'stop', passwords: true },
      { kind: 'read' },
    ])
    expect('passwords' in calls[2]!).toBe(false)
    expect(text(typed)).toContain(
      "waits for a password; type it with terminal_input if the user gave it to you for that or the project's files hold it, otherwise ask the user to type it there, then call terminal_wait",
    )
    const listed = terminalTools.listed(TERMINAL_TOOLS)
    expect(listed.map((tool) => tool.name)).toEqual(TERMINAL_TOOLS.map((tool) => tool.name))
    const input = listed.find((tool) => tool.name === 'terminal_input')!
    expect(input.description).not.toContain('Never types a password')
    expect(input.description).toContain(
      "Types a password only when the user gave it to you for that or the project's files hold it",
    )
  })
})
