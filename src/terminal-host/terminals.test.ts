import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalCall, TerminalCallAnswer } from '@shared/terminal-agent'
import type { TerminalInfo } from '@shared/terminal-host'
import { ProjectRegistry } from './projects'
import type { TtyModes } from './password'
import { type PtyProcess, TerminalManager } from './terminals'

class FakePty implements PtyProcess {
  readonly pid = 4242
  process = 'zsh'
  readonly ptsName = '/dev/ttys042'
  readonly written: string[] = []
  private data: ((data: string) => void) | null = null
  onData(listener: (data: string) => void) {
    this.data = listener
    return { dispose: () => undefined }
  }
  onExit() {
    return { dispose: () => undefined }
  }
  write(data: string): void {
    this.written.push(data)
  }
  emit(data: string): void {
    this.data?.(data)
  }
  resize(): void {}
  kill(): void {}
  pause(): void {}
  resume(): void {}
}

function host(
  modes: TtyModes | null = { echo: true, icanon: true },
  commandLine: (pty: PtyProcess) => Promise<string[] | null> = async () => null,
) {
  const ptys: FakePty[] = []
  const infos: TerminalInfo[] = []
  const handedBack: [string, number][] = []
  const cwds: string[] = []
  // `/work/app/out` is a link that leads out of the project.
  const projects = new ProjectRegistry('darwin', async (path) =>
    path.startsWith('/work/app/out') ? path.replace('/work/app/out', '/etc') : path,
  )
  projects.set(['/work/app'])
  const manager = new TerminalManager({
    platform: 'darwin',
    appVersion: '0.0.0',
    env: { SHELL: '/bin/zsh' },
    projects,
    findOnPath: async () => null,
    loadPty: async () => (_file, _args, options) => {
      cwds.push(options.cwd)
      const pty = new FakePty()
      ptys.push(pty)
      return pty
    },
    sink: {
      data: () => undefined,
      replay: () => undefined,
      info: (i) => infos.push(i),
      removed: () => undefined,
    },
    handedBack: (sessionId, ms) => handedBack.push([sessionId, ms]),
    commandLine,
    ttyModes: async () => modes,
  })
  return { manager, ptys, infos, handedBack, cwds }
}

/** Lets the shell print its prompt, after which a command waiting to be typed goes in. */
async function promptShown(pty: FakePty): Promise<void> {
  pty.emit('% ')
  await vi.advanceTimersByTimeAsync(500)
}

function terminalOf(answer: TerminalCallAnswer): string {
  if (!('result' in answer) || answer.result.kind !== 'terminal') {
    throw new Error(`Not a terminal: ${JSON.stringify(answer)}`)
  }
  return answer.result.terminal.id
}

const RUN = {
  kind: 'run',
  sessionId: 's1',
  agentId: 'claude-code',
  folder: '/work/app',
  command: 'pnpm dev',
} as const

describe('terminals an agent starts', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs the command with Enter and records the owner', async () => {
    const { manager, ptys } = host()
    const id = terminalOf(await manager.agentCall(RUN))
    await promptShown(ptys[0]!)
    expect(ptys[0]!.written).toEqual(['pnpm dev\r'])
    const [info] = await manager.list()
    expect(info).toMatchObject({
      id,
      sessionId: 's1',
      owner: { agentId: 'claude-code', sessionId: 's1' },
      control: { kind: 'agent', acting: false },
    })
  })

  it('never presses Enter for a command a port sends, unless the agent host built it', async () => {
    const { manager, ptys } = host()
    await manager.create('window', {
      projectPath: '/work/app',
      cols: 80,
      rows: 24,
      command: { text: 'rm -rf ~', run: true },
    })
    await promptShown(ptys[0]!)
    expect(ptys[0]!.written).toEqual(['rm -rf ~'])
    const [info] = await manager.list()
    expect(info?.owner).toBeNull()
  })

  it('opens only in a known folder', async () => {
    const { manager, ptys } = host()
    const answer = await manager.agentCall({ ...RUN, folder: '/etc' })
    expect(answer).toMatchObject({ error: { code: 'restricted' } })
    expect(ptys).toHaveLength(0)
  })

  it('starts in a folder of its project, never one a link leads out to', async () => {
    const { manager, cwds } = host()
    const size = { projectPath: '/work/app', cols: 80, rows: 24 }
    await manager.create('port', { ...size, folder: 'src/lib' })
    await manager.create('port', size)
    expect(cwds).toEqual(['/work/app/src/lib', '/work/app'])
    await expect(manager.create('port', { ...size, folder: 'out/x' })).rejects.toMatchObject({
      code: 'restricted',
    })
    expect(cwds).toHaveLength(2)
  })

  it('refuses a command with a newline or another control character', async () => {
    const { manager, ptys } = host()
    for (const command of ['pnpm dev\nrm -rf ~', 'ls\x1b[A', 'ls\r']) {
      expect(await manager.agentCall({ ...RUN, command })).toMatchObject({
        error: { code: 'failed' },
      })
    }
    expect(ptys).toHaveLength(0)
  })

  it("reaches only its own session's terminals", async () => {
    const { manager, ptys } = host()
    const id = terminalOf(await manager.agentCall(RUN))
    const user = await manager.create('window', { projectPath: '/work/app', cols: 80, rows: 24 })
    for (const call of [
      { kind: 'input', sessionId: 's2', terminalId: id, text: 'y', enter: true },
      { kind: 'read', sessionId: 's2', terminalId: id, lines: 10 },
      { kind: 'stop', sessionId: 's2', terminalId: id, close: true },
      { kind: 'input', sessionId: 's1', terminalId: user.id, text: 'y', enter: true },
      { kind: 'stop', sessionId: 's1', terminalId: user.id, close: false },
    ] as const) {
      expect(await manager.agentCall(call)).toMatchObject({ error: { code: 'not_found' } })
    }
    expect(ptys[1]!.written).toEqual([])
    expect(await manager.list()).toHaveLength(2)
  })

  it("holds back the user's keys but Ctrl+C while its turn uses the terminal", async () => {
    const { manager, ptys } = host()
    const id = terminalOf(await manager.agentCall(RUN))
    await promptShown(ptys[0]!)
    manager.input(id, 'q')
    manager.input(id, '\x03')
    expect(ptys[0]!.written).toEqual(['pnpm dev\r', '\x03'])
    expect(manager.takeOver(id)).toBe(true)
    manager.input(id, 'q')
    expect(ptys[0]!.written.at(-1)).toBe('q')
  })

  it('waits while the user has it and goes on once they hand it back', async () => {
    const { manager, ptys, handedBack } = host()
    const id = terminalOf(await manager.agentCall(RUN))
    await promptShown(ptys[0]!)
    manager.takeOver(id)
    const typing = manager.agentCall({
      kind: 'input',
      sessionId: 's1',
      terminalId: id,
      text: 'y',
      enter: true,
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(ptys[0]!.written).toEqual(['pnpm dev\r'])
    expect(manager.handBack(id)).toBe(true)
    expect(await typing).toMatchObject({ result: { kind: 'terminal' } })
    expect(ptys[0]!.written.at(-1)).toBe('y\r')
    expect(handedBack.map(([sessionId]) => sessionId)).toEqual(['s1'])
  })

  it('answers held when the user keeps it past the wait', async () => {
    const { manager, ptys } = host()
    const id = terminalOf(await manager.agentCall(RUN))
    await promptShown(ptys[0]!)
    manager.takeOver(id)
    const stopping = manager.agentCall({
      kind: 'stop',
      sessionId: 's1',
      terminalId: id,
      close: false,
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await stopping).toEqual({ result: { kind: 'held' } })
    expect(ptys[0]!.written).toEqual(['pnpm dev\r'])
  })

  it('lets the user type once the turn ends, and a restart makes it theirs', async () => {
    const { manager, ptys } = host()
    const id = terminalOf(await manager.agentCall(RUN))
    await promptShown(ptys[0]!)
    manager.turnEnded('s2')
    manager.input(id, 'a')
    expect(ptys[0]!.written).toEqual(['pnpm dev\r'])
    manager.turnEnded('s1')
    manager.input(id, 'a')
    expect(ptys[0]!.written.at(-1)).toBe('a')
    const restarted = await manager.restart(id)
    expect(restarted).toMatchObject({ owner: null, control: { kind: 'idle' } })
    // The user's now: the agent asks them before it reads it again.
    expect(
      await manager.agentCall({ kind: 'read', sessionId: 's1', terminalId: id, lines: 5 }),
    ).toMatchObject({ result: { kind: 'ask', terminal: { opener: 'user', usable: false } } })
  })

  it('reads its output as plain text', async () => {
    const { manager, ptys } = host()
    const id = terminalOf(await manager.agentCall(RUN))
    ptys[0]!.emit('\x1b]0;title\x07\x1b[32mready\x1b[0m on http://localhost:5173\r\n50%\r100%\r\n')
    expect(
      await manager.agentCall({ kind: 'read', sessionId: 's1', terminalId: id, lines: 10 }),
    ).toMatchObject({
      result: { kind: 'output', output: 'ready on http://localhost:5173\n100%' },
    })
  })
})

const REPLY: Extract<TerminalCall, { kind: 'reply' }> = {
  kind: 'reply',
  sessionId: 's1',
  agentId: 'claude-code',
  folder: '/work/app',
  command: 'pnpm dev',
  fromDevice: false,
}

/** Starts a reply's run, lets the shell print its prompt and returns the answer. */
async function replyRun(
  manager: TerminalManager,
  ptys: FakePty[],
  call: Partial<typeof REPLY> = {},
  prompt = '% ',
): Promise<TerminalCallAnswer> {
  const answer = manager.agentCall({ ...REPLY, ...call })
  await vi.advanceTimersByTimeAsync(0)
  ptys.at(-1)?.emit(prompt)
  await vi.advanceTimersByTimeAsync(500)
  return answer
}

/** A program in the foreground prints a prompt and goes quiet. */
async function prompts(pty: FakePty, program: string, text: string): Promise<void> {
  pty.process = program
  pty.emit(text)
  await vi.advanceTimersByTimeAsync(400)
}

describe('terminals the user opens', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const size = { projectPath: '/work/app', cols: 80, rows: 24 }
  const read = (terminalId: string, sessionId = 's1') =>
    ({ kind: 'read', sessionId, terminalId, lines: 5 }) as const
  const allow = (terminalId: string, allowed: boolean, sessionId = 's1') =>
    ({ kind: 'allow', sessionId, terminalId, allowed }) as const

  it("asks first, then lets the session's agent use it once allowed", async () => {
    const { manager, ptys } = host()
    const user = await manager.create('window', { ...size, sessionId: 's1' })
    expect(await manager.agentCall(read(user.id))).toMatchObject({
      result: { kind: 'ask', terminal: { id: user.id, opener: 'user', usable: false } },
    })
    const typing = {
      kind: 'input',
      sessionId: 's1',
      terminalId: user.id,
      text: 'ls',
      enter: true,
    } as const
    expect(await manager.agentCall(typing)).toMatchObject({ result: { kind: 'ask' } })
    expect(ptys[0]!.written).toEqual([])

    expect(await manager.agentCall(allow(user.id, true))).toMatchObject({
      result: { kind: 'terminal', terminal: { usable: true } },
    })
    expect((await manager.list()).find((info) => info.id === user.id)?.agentAllowed).toBe(true)
    expect(await manager.agentCall(read(user.id))).toMatchObject({ result: { kind: 'output' } })
    expect(await manager.agentCall(typing)).toMatchObject({ result: { kind: 'terminal' } })
    expect(ptys[0]!.written).toEqual(['ls\r'])
  })

  it("lists the session's terminals, the user's with whether the agent may use them", async () => {
    const { manager } = host()
    const own = terminalOf(await manager.agentCall(RUN))
    const user = await manager.create('window', { ...size, sessionId: 's1' })
    await manager.create('window', { ...size, sessionId: 's2' })
    const answer = await manager.agentCall({ kind: 'list', sessionId: 's1' })
    expect(answer).toMatchObject({
      result: {
        kind: 'list',
        terminals: [
          { id: own, opener: 'agent', usable: true },
          { id: user.id, opener: 'user', usable: false },
        ],
      },
    })
  })

  it("never reaches another session's terminal, even to allow it", async () => {
    const { manager } = host()
    const user = await manager.create('window', { ...size, sessionId: 's1' })
    expect(await manager.agentCall(allow(user.id, true, 's2'))).toMatchObject({
      error: { code: 'not_found' },
    })
    expect(await manager.agentCall(read(user.id, 's2'))).toMatchObject({
      error: { code: 'not_found' },
    })
    expect((await manager.list()).find((info) => info.id === user.id)?.agentAllowed).toBe(false)
  })

  it('asks again once the user takes it back or restarts its shell', async () => {
    const { manager } = host()
    const user = await manager.create('window', { ...size, sessionId: 's1' })
    await manager.agentCall(allow(user.id, true))
    await manager.agentCall(allow(user.id, false))
    expect(await manager.agentCall(read(user.id))).toMatchObject({ result: { kind: 'ask' } })

    await manager.agentCall(allow(user.id, true))
    const restarted = await manager.restart(user.id)
    expect(restarted.agentAllowed).toBe(false)
    expect(await manager.agentCall(read(user.id))).toMatchObject({ result: { kind: 'ask' } })
  })

  it("only reads the user's terminal while the session plans", async () => {
    const { manager, ptys } = host()
    const user = await manager.create('window', { ...size, sessionId: 's1' })
    await manager.agentCall(allow(user.id, true))
    const typing = {
      kind: 'input',
      sessionId: 's1',
      terminalId: user.id,
      text: 'ls',
      enter: true,
      readOnly: true,
    } as const
    expect(await manager.agentCall(typing)).toMatchObject({ error: { code: 'not_allowed' } })
    expect(
      await manager.agentCall({
        kind: 'stop',
        sessionId: 's1',
        terminalId: user.id,
        close: false,
        readOnly: true,
      }),
    ).toMatchObject({ error: { code: 'not_allowed' } })
    expect(ptys[0]!.written).toEqual([])

    const own = terminalOf(await manager.agentCall(RUN))
    await promptShown(ptys[1]!)
    expect(await manager.agentCall({ ...typing, terminalId: own })).toMatchObject({
      result: { kind: 'terminal' },
    })
  })

  it("leaves an agent's own terminal as it is when allowed", async () => {
    const { manager } = host()
    const own = terminalOf(await manager.agentCall(RUN))
    expect(await manager.agentCall(allow(own, false))).toMatchObject({
      result: { kind: 'terminal', terminal: { usable: true } },
    })
    expect(await manager.agentCall(read(own))).toMatchObject({ result: { kind: 'output' } })
  })
})

describe("a terminal's name", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const size = { projectPath: '/work/app', cols: 80, rows: 24 }
  const rename = (terminalId: string, name: string, asked = false) =>
    ({ kind: 'rename', sessionId: 's1', terminalId, name, asked }) as const

  it('is the command line of what runs, kept once it ends', async () => {
    const { manager, ptys } = host(undefined, async () => ['node', '/opt/homebrew/bin/pnpm', 'dev'])
    const user = await manager.create('window', { ...size, sessionId: 's1' })
    const pty = ptys[0]!
    pty.emit('% ')
    await vi.advanceTimersByTimeAsync(200)
    expect((await manager.list())[0]!.title).toBe('zsh')
    pty.process = 'node'
    pty.emit('ready\r\n')
    await vi.advanceTimersByTimeAsync(200)
    expect((await manager.list())[0]).toMatchObject({ id: user.id, title: 'pnpm dev', busy: true })
    pty.process = 'zsh'
    pty.emit('% ')
    await vi.advanceTimersByTimeAsync(200)
    expect((await manager.list())[0]).toMatchObject({ title: 'pnpm dev', busy: false })
  })

  it('is what the user names it, everywhere, until they clear it', async () => {
    const { manager } = host()
    const user = await manager.create('window', { ...size, sessionId: 's1' })
    expect(manager.rename(user.id, '  Deploy  ')).toMatchObject({ name: 'Deploy', namedBy: 'user' })
    expect(() => manager.rename(user.id, 'x'.repeat(41))).toThrow()
    expect(() => manager.rename(user.id, 'a\nb')).toThrow()
    const restarted = await manager.restart(user.id)
    expect(restarted).toMatchObject({ name: 'Deploy', namedBy: 'user', title: 'zsh' })
    expect(manager.rename(user.id, '')).toMatchObject({ name: null, namedBy: null })
  })

  it("takes the name an agent gives its terminal, or else the agent's command", async () => {
    const { manager } = host()
    const named = await manager.agentCall({ ...RUN, name: 'Dev server' })
    expect(named).toMatchObject({
      result: { terminal: { name: 'Dev server', namedBy: 'agent', title: 'pnpm dev' } },
    })
    const plain = await manager.agentCall(RUN)
    expect(plain).toMatchObject({ result: { terminal: { name: null, title: 'pnpm dev' } } })
    expect(await manager.agentCall({ ...RUN, name: 'x'.repeat(41) })).toMatchObject({
      error: { code: 'failed' },
    })
  })

  it("lets an agent rename its own terminal, and asks before it renames the user's", async () => {
    const { manager } = host()
    const own = terminalOf(await manager.agentCall(RUN))
    expect(await manager.agentCall(rename(own, 'Server'))).toMatchObject({
      result: { kind: 'terminal', terminal: { name: 'Server', namedBy: 'agent' } },
    })

    manager.rename(own, 'Mine')
    expect(await manager.agentCall(rename(own, 'Server'))).toMatchObject({
      result: { kind: 'ask' },
    })
    expect((await manager.list())[0]!.name).toBe('Mine')
    expect(await manager.agentCall(rename(own, 'Server', true))).toMatchObject({
      result: { terminal: { name: 'Server', namedBy: 'agent' } },
    })

    const user = await manager.create('window', { ...size, sessionId: 's1' })
    expect(await manager.agentCall(rename(user.id, 'Logs'))).toMatchObject({
      result: { kind: 'ask' },
    })
    await manager.agentCall({ kind: 'allow', sessionId: 's1', terminalId: user.id, allowed: true })
    expect(await manager.agentCall(rename(user.id, 'Logs'))).toMatchObject({
      result: { terminal: { name: 'Logs' } },
    })
    expect(
      await manager.agentCall({ ...rename(user.id, 'Logs', true), sessionId: 's2' }),
    ).toMatchObject({ error: { code: 'not_found' } })
  })
})

describe('code blocks the user runs from a reply', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("runs the block with Enter in a terminal of the agent's that the user types into", async () => {
    const { manager, ptys } = host()
    const id = terminalOf(await replyRun(manager, ptys))
    expect(ptys[0]!.written).toEqual(['pnpm dev\r'])
    const [info] = await manager.list()
    expect(info).toMatchObject({
      id,
      sessionId: 's1',
      owner: { agentId: 'claude-code', sessionId: 's1', fromReply: true },
      control: { kind: 'idle' },
    })
    manager.input(id, 'q')
    expect(ptys[0]!.written.at(-1)).toBe('q')
    expect(
      await manager.agentCall({ kind: 'read', sessionId: 's1', terminalId: id, lines: 5 }),
    ).toMatchObject({ result: { kind: 'output' } })
  })

  it('pastes a block of several lines at once, then presses Enter', async () => {
    const { manager, ptys } = host()
    await replyRun(manager, ptys, { command: 'sudo true\npnpm dev\n' }, '\x1b[?2004h% ')
    expect(ptys[0]!.written).toEqual(['\x1b[200~sudo true\rpnpm dev\x1b[201~\r'])
  })

  it('refuses a block of several lines where the shell takes no bracketed paste', async () => {
    const { manager, ptys } = host()
    const answer = await replyRun(manager, ptys, { command: 'sudo true\npnpm dev' })
    expect(answer).toMatchObject({ error: { code: 'failed' } })
    expect(ptys[0]!.written).toEqual([])
    expect(await manager.list()).toEqual([])
  })

  it('refuses a block holding control or invisible characters', async () => {
    const { manager, ptys } = host()
    for (const command of ['ls\x1b[A', 'ls\r', 'rm -rf /tmp/a\u202e', 'echo\u200bhi', '  ']) {
      expect(await manager.agentCall({ ...REPLY, command })).toMatchObject({
        error: { code: 'failed' },
      })
    }
    expect(ptys).toHaveLength(0)
  })

  it("is reached by its own session's agent only", async () => {
    const { manager, ptys } = host()
    const id = terminalOf(await replyRun(manager, ptys))
    expect(
      await manager.agentCall({ kind: 'read', sessionId: 's2', terminalId: id, lines: 5 }),
    ).toMatchObject({ error: { code: 'not_found' } })
  })
})

describe('a terminal waiting for a password', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('is told when a program reads one, and no longer once output goes on', async () => {
    const { manager, ptys } = host({ echo: false, icanon: true })
    const id = terminalOf(await replyRun(manager, ptys))
    await prompts(ptys[0]!, 'sudo', '[sudo] password for me: ')
    expect((await manager.list())[0]).toMatchObject({ id, waiting: 'password' })
    ptys[0]!.emit('\r\n')
    await vi.advanceTimersByTimeAsync(10)
    expect((await manager.list())[0]).toMatchObject({ waiting: null })
  })

  it('is not a full-screen program, the shell at its prompt or a line that ended', async () => {
    const raw = host({ echo: false, icanon: false })
    await replyRun(raw.manager, raw.ptys)
    await prompts(raw.ptys[0]!, 'vim', 'INSERT ')
    expect((await raw.manager.list())[0]?.waiting).toBeNull()

    const atPrompt = host({ echo: false, icanon: true })
    await replyRun(atPrompt.manager, atPrompt.ptys)
    await prompts(atPrompt.ptys[0]!, 'zsh', '% ')
    expect((await atPrompt.manager.list())[0]?.waiting).toBeNull()

    const lines = host({ echo: false, icanon: true })
    await replyRun(lines.manager, lines.ptys)
    await prompts(lines.ptys[0]!, 'node', 'ready on http://localhost:5173\r\n')
    expect((await lines.manager.list())[0]?.waiting).toBeNull()
  })

  it("lets the user's keys in while the agent's turn uses the terminal", async () => {
    const { manager, ptys } = host({ echo: false, icanon: true })
    const id = terminalOf(await manager.agentCall(RUN))
    await promptShown(ptys[0]!)
    manager.input(id, 'q')
    expect(ptys[0]!.written).toEqual(['pnpm dev\r'])
    await prompts(ptys[0]!, 'sudo', 'Password: ')
    manager.input(id, 'secret\r')
    expect(ptys[0]!.written.at(-1)).toBe('secret\r')
  })

  it("holds the agent's input until the password is typed", async () => {
    const { manager, ptys } = host({ echo: false, icanon: true })
    const id = terminalOf(await manager.agentCall(RUN))
    await promptShown(ptys[0]!)
    await prompts(ptys[0]!, 'sudo', 'Password: ')
    const typing = manager.agentCall({
      kind: 'input',
      sessionId: 's1',
      terminalId: id,
      text: 'guess',
      enter: true,
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await typing).toEqual({ result: { kind: 'password' } })
    expect(ptys[0]!.written).toEqual(['pnpm dev\r'])
  })

  it("types the agent's input at once when the user lets agents type passwords", async () => {
    const { manager, ptys } = host({ echo: false, icanon: true })
    const id = terminalOf(await manager.agentCall(RUN))
    await promptShown(ptys[0]!)
    await prompts(ptys[0]!, 'sudo', 'Password: ')
    const typed = await manager.agentCall({
      kind: 'input',
      sessionId: 's1',
      terminalId: id,
      text: 'test-account',
      enter: true,
      passwords: true,
    })
    expect(typed).toMatchObject({ result: { kind: 'terminal', terminal: { id } } })
    expect(ptys[0]!.written).toEqual(['pnpm dev\r', 'test-account\r'])
  })

  it("holds the agent's stop until the password is typed, unless agents may type them", async () => {
    const { manager, ptys } = host({ echo: false, icanon: true })
    const id = terminalOf(await manager.agentCall(RUN))
    await promptShown(ptys[0]!)
    await prompts(ptys[0]!, 'sudo', 'Password: ')
    const stop = { kind: 'stop', sessionId: 's1', terminalId: id, close: false } as const
    const held = manager.agentCall(stop)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await held).toEqual({ result: { kind: 'password' } })
    expect(ptys[0]!.written).toEqual(['pnpm dev\r'])
    expect(await manager.agentCall({ ...stop, passwords: true })).toMatchObject({
      result: { kind: 'terminal' },
    })
    expect(ptys[0]!.written).toEqual(['pnpm dev\r', '\x03'])
  })

  it('still tells a wait about the password when agents may type them', async () => {
    const { manager, ptys } = host({ echo: false, icanon: true })
    const id = terminalOf(await manager.agentCall(RUN))
    await promptShown(ptys[0]!)
    await prompts(ptys[0]!, 'sudo', 'Password: ')
    expect(
      await manager.agentCall({ kind: 'wait', sessionId: 's1', terminalId: id, lines: 5 }),
    ).toMatchObject({ result: { reason: 'password', terminal: { password: true } } })
  })

  it('ends a wait with the reason', async () => {
    const { manager, ptys } = host({ echo: false, icanon: true })
    const id = terminalOf(await replyRun(manager, ptys))
    const waiting = manager.agentCall({ kind: 'wait', sessionId: 's1', terminalId: id, lines: 5 })
    await prompts(ptys[0]!, 'sudo', '[sudo] password for me: ')
    await vi.advanceTimersByTimeAsync(400)
    expect(await waiting).toMatchObject({
      result: {
        kind: 'output',
        reason: 'password',
        terminal: { password: true },
        output: '% [sudo] password for me:',
      },
    })
  })
})
