import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalInfo } from '@shared/terminal-host'
import { ProjectRegistry } from './projects'
import { type PtyProcess, type PtySpawn, TerminalError, TerminalManager } from './terminals'

class FakePty implements PtyProcess {
  readonly pid = 4242
  process = 'zsh'
  written: string[] = []
  paused = false
  killed = false
  size: [number, number]
  private dataListeners: ((data: string) => void)[] = []
  private exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = []

  constructor(
    readonly file: string,
    readonly args: string[],
    readonly options: Parameters<PtySpawn>[2],
  ) {
    this.size = [options.cols, options.rows]
  }

  onData(listener: (data: string) => void) {
    this.dataListeners.push(listener)
    return { dispose: () => {} }
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.push(listener)
    return { dispose: () => {} }
  }

  write(data: string): void {
    this.written.push(data)
  }

  resize(cols: number, rows: number): void {
    this.size = [cols, rows]
  }

  kill(): void {
    this.killed = true
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
  }

  emit(data: string): void {
    for (const listener of this.dataListeners) listener(data)
  }

  exit(exitCode: number, signal?: number): void {
    for (const listener of this.exitListeners) listener({ exitCode, signal })
  }
}

const PROJECT = '/work/app'
const AUTH = 'npx -y @agentclientprotocol/claude-agent-acp@0.94.0 --cli auth login'

function setup(platform: NodeJS.Platform = 'darwin') {
  const ptys: FakePty[] = []
  const events: { kind: string; value: unknown }[] = []
  const projects = new ProjectRegistry(platform, async (path) => path)
  projects.set([PROJECT])
  const manager = new TerminalManager({
    platform,
    appVersion: '0.1.0',
    env: { SHELL: '/bin/zsh', PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' },
    projects,
    findOnPath: async () => null,
    loadPty: async () => (file, args, options) => {
      const pty = new FakePty(file, args, options)
      ptys.push(pty)
      return pty
    },
    consoleProcesses: async () => [1, 2],
    sink: {
      data: (id, data, ports) =>
        events.push({ kind: 'data', value: { id, data, ports: [...ports] } }),
      info: (info) => events.push({ kind: 'info', value: info }),
      removed: (id) => events.push({ kind: 'removed', value: id }),
    },
  })
  manager.setAuthCommands([AUTH])
  const infos = () =>
    events.filter((event) => event.kind === 'info').map((event) => event.value as TerminalInfo)
  return { manager, ptys, events, infos }
}

describe('TerminalManager', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('starts the login shell in the project with the terminal environment', async () => {
    const { manager, ptys } = setup()
    const info = await manager.create('p1', { projectPath: PROJECT, cols: 100, rows: 30 })
    expect(info).toMatchObject({ projectPath: PROJECT, shell: 'zsh', title: 'zsh', busy: false })
    expect(info.exitCode).toBeNull()
    const [pty] = ptys
    expect(pty.file).toBe('/bin/zsh')
    expect(pty.args).toEqual(['-l'])
    expect(pty.options.cwd).toBe(PROJECT)
    expect(pty.size).toEqual([100, 30])
    expect(pty.options.env.TERM).toBe('xterm-256color')
    expect(pty.options.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('refuses folders that are not a known project', async () => {
    const { manager } = setup()
    await expect(
      manager.create('p1', { projectPath: '/etc', cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ code: 'restricted' })
  })

  it('batches output for 5 ms and sends it to attached ports only', async () => {
    const { manager, ptys, events } = setup()
    const { id } = await manager.create('p1', { projectPath: PROJECT, cols: 80, rows: 24 })
    ptys[0].emit('a')
    ptys[0].emit('b')
    expect(events.filter((event) => event.kind === 'data')).toEqual([])
    vi.advanceTimersByTime(5)
    expect(events.filter((event) => event.kind === 'data')).toEqual([
      { kind: 'data', value: { id, data: 'ab', ports: ['p1'] } },
    ])
  })

  it('replays output to a port that attaches later, then streams to it', async () => {
    const { manager, ptys, events } = setup()
    const { id } = await manager.create('p1', { projectPath: PROJECT, cols: 80, rows: 24 })
    ptys[0].emit('before ')
    vi.advanceTimersByTime(5)
    ptys[0].emit('pending')
    expect(manager.attach('p2', id)).toEqual({ replay: 'before pending' })
    ptys[0].emit('!')
    vi.advanceTimersByTime(5)
    expect(events.filter((event) => event.kind === 'data').at(-1)).toEqual({
      kind: 'data',
      value: { id, data: '!', ports: ['p1', 'p2'] },
    })
  })

  it('pauses the pty until the renderer acknowledges what it drew', async () => {
    const { manager, ptys } = setup()
    const { id } = await manager.create('p1', { projectPath: PROJECT, cols: 80, rows: 24 })
    ptys[0].emit('x'.repeat(100_001))
    vi.advanceTimersByTime(5)
    expect(ptys[0].paused).toBe(true)
    manager.ack('p1', id, 96_000)
    expect(ptys[0].paused).toBe(false)
  })

  it('resumes a paused pty when its only port closes', async () => {
    const { manager, ptys } = setup()
    await manager.create('p1', { projectPath: PROJECT, cols: 80, rows: 24 })
    ptys[0].emit('x'.repeat(100_001))
    vi.advanceTimersByTime(5)
    manager.detach('p1')
    expect(ptys[0].paused).toBe(false)
  })

  it('follows the foreground process for the title and busy state', async () => {
    const { manager, ptys, infos } = setup()
    const { id } = await manager.create('p1', { projectPath: PROJECT, cols: 80, rows: 24 })
    ptys[0].emit('$ ')
    vi.advanceTimersByTime(105)
    ptys[0].process = 'node'
    ptys[0].emit('pnpm dev\r\n')
    vi.advanceTimersByTime(105)
    expect(infos().at(-1)).toMatchObject({ id, title: 'node', busy: true })
    expect(await manager.busy()).toEqual([{ id, projectPath: PROJECT, title: 'node' }])
    ptys[0].process = 'zsh'
    ptys[0].emit('$ ')
    vi.advanceTimersByTime(105)
    expect(infos().at(-1)).toMatchObject({ title: 'zsh', busy: false })
    expect(await manager.busy()).toEqual([])
  })

  it('sees a command typed before the first title check as busy', async () => {
    const { manager, ptys, infos } = setup()
    await manager.create('p1', { projectPath: PROJECT, cols: 80, rows: 24 })
    ptys[0].emit('$ ')
    ptys[0].process = 'sleep'
    ptys[0].emit('sleep 3\r\n')
    vi.advanceTimersByTime(105)
    expect(infos().at(-1)).toMatchObject({ title: 'sleep', busy: true })
  })

  it('treats the first foreground name as the shell itself', async () => {
    const { manager, ptys, infos } = setup()
    manager.setShellPath('/bin/sh')
    await manager.create('p1', { projectPath: PROJECT, cols: 80, rows: 24 })
    ptys[0].process = '-bash'
    ptys[0].emit('$ ')
    vi.advanceTimersByTime(105)
    expect(infos().at(-1)).toMatchObject({ shell: 'sh', title: 'bash', busy: false })
  })

  it('uses the shell title and the console process list on Windows', async () => {
    const { manager, ptys, infos } = setup('win32')
    const { id } = await manager.create('p1', { projectPath: PROJECT, cols: 80, rows: 24 })
    expect(ptys[0].file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    ptys[0].emit('\x1b]0;Windows PowerShell\x07PS> ')
    vi.advanceTimersByTime(105)
    expect(infos().at(-1)).toMatchObject({ title: 'Windows PowerShell', busy: false })
    expect(await manager.busy()).toEqual([
      { id, projectPath: PROJECT, title: 'Windows PowerShell' },
    ])
  })

  it('reports the exit code and can restart the shell', async () => {
    const { manager, ptys, infos } = setup()
    const { id } = await manager.create('p1', { projectPath: PROJECT, cols: 80, rows: 24 })
    ptys[0].exit(0, 15)
    expect(infos().at(-1)).toMatchObject({ id, exitCode: 143, busy: false })
    manager.input(id, 'ignored')
    expect(ptys[0].written).toEqual([])
    const restarted = await manager.restart(id)
    expect(restarted).toMatchObject({ id, exitCode: null })
    expect(ptys).toHaveLength(2)
    ptys[0].exit(1)
    expect(infos().at(-1)?.exitCode).toBeNull()
  })

  it('kills and forgets a terminal', async () => {
    const { manager, ptys, events } = setup()
    const { id } = await manager.create('p1', { projectPath: PROJECT, cols: 80, rows: 24 })
    manager.kill(id)
    expect(ptys[0].killed).toBe(true)
    expect(events.at(-1)).toEqual({ kind: 'removed', value: id })
    expect(() => manager.input(id, 'x')).toThrow(TerminalError)
    expect(await manager.list()).toEqual([])
  })

  it('passes input and resizes through', async () => {
    const { manager, ptys } = setup()
    const { id } = await manager.create('p1', { projectPath: PROJECT, cols: 80, rows: 24 })
    manager.input(id, 'ls\r')
    manager.resize(id, 120, 40)
    expect(ptys[0].written).toEqual(['ls\r'])
    expect(ptys[0].size).toEqual([120, 40])
    expect(await manager.list(PROJECT)).toHaveLength(1)
    expect(await manager.list('/elsewhere')).toEqual([])
  })

  describe('typed commands', () => {
    async function typed(command: { text: string; run: boolean }, output = '$ ') {
      const { manager, ptys } = setup()
      await manager.create('p1', { projectPath: PROJECT, cols: 80, rows: 24, command })
      ptys[0].emit(output)
      vi.advanceTimersByTime(5)
      expect(ptys[0].written).toEqual([])
      vi.advanceTimersByTime(150)
      return ptys[0].written
    }

    it('runs a sign-in command the agent host built', async () => {
      expect(await typed({ text: AUTH, run: true })).toEqual([`${AUTH}\r`])
    })

    it('only types any other command, even when asked to run it', async () => {
      expect(await typed({ text: 'rm -rf build', run: true })).toEqual(['rm -rf build'])
      expect(await typed({ text: 'pnpm test', run: false })).toEqual(['pnpm test'])
    })

    it('pastes a multi-line command only with bracketed paste', async () => {
      expect(await typed({ text: 'a\nb', run: false }, '\x1b[?2004h$ ')).toEqual([
        '\x1b[200~a\rb\x1b[201~',
      ])
      expect(await typed({ text: 'a\nb', run: false })).toEqual([])
    })

    it('types after 3 s even if the shell stays quiet', async () => {
      const { manager, ptys } = setup()
      await manager.create('p1', {
        projectPath: PROJECT,
        cols: 80,
        rows: 24,
        command: { text: 'ls', run: false },
      })
      vi.advanceTimersByTime(3000)
      expect(ptys[0].written).toEqual(['ls'])
    })
  })

  it('reports a pty that cannot be loaded as unavailable', async () => {
    const projects = new ProjectRegistry('linux', async (path) => path)
    projects.set([PROJECT])
    const manager = new TerminalManager({
      platform: 'linux',
      appVersion: '0.1.0',
      env: {},
      projects,
      findOnPath: async () => null,
      loadPty: async () => {
        throw new Error('pty.node: wrong ELF class')
      },
      sink: { data: () => {}, info: () => {}, removed: () => {} },
    })
    await expect(
      manager.create('p1', { projectPath: PROJECT, cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ code: 'internal', message: expect.stringContaining('wrong ELF') })
  })

  it('kills every shell on dispose', async () => {
    const { manager, ptys } = setup()
    await manager.create('p1', { projectPath: PROJECT, cols: 80, rows: 24 })
    await manager.create('p1', { projectPath: PROJECT, cols: 80, rows: 24 })
    manager.dispose()
    expect(ptys.every((pty) => pty.killed)).toBe(true)
  })
})
