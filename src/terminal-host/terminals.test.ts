import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalCallAnswer } from '@shared/terminal-agent'
import type { TerminalInfo } from '@shared/terminal-host'
import { ProjectRegistry } from './projects'
import { type PtyProcess, TerminalManager } from './terminals'

class FakePty implements PtyProcess {
  readonly pid = 4242
  readonly process = 'zsh'
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

function host() {
  const ptys: FakePty[] = []
  const infos: TerminalInfo[] = []
  const handedBack: [string, number][] = []
  const projects = new ProjectRegistry('darwin', async (path) => path)
  projects.set(['/work/app'])
  const manager = new TerminalManager({
    platform: 'darwin',
    appVersion: '0.0.0',
    env: { SHELL: '/bin/zsh' },
    projects,
    findOnPath: async () => null,
    loadPty: async () => () => {
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
  })
  return { manager, ptys, infos, handedBack }
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
    expect(
      await manager.agentCall({ kind: 'read', sessionId: 's1', terminalId: id, lines: 5 }),
    ).toMatchObject({ error: { code: 'not_found' } })
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
