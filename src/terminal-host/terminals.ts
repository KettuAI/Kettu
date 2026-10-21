import { randomUUID } from 'node:crypto'
import type { BusyTerminal } from '@shared/host-control'
import type { Platform } from '@shared/platform'
import type { PortErrorCode } from '@shared/port-rpc'
import type { TerminalCommand, TerminalInfo, TerminalParams } from '@shared/terminal-host'
import { TERMINAL_FLOW } from '@shared/terminal-host'
import { FlowControl } from './flow'
import { OutputScanner } from './output-scanner'
import type { ProjectRegistry } from './projects'
import { ReplayBuffer } from './replay'
import {
  type Environment,
  type FindOnPath,
  pathLookup,
  resolveShell,
  shellEnvironment,
  type ShellSpec,
} from './shell'

/** The part of node-pty's `IPty` the manager uses, so tests can drive it with a fake. */
export interface PtyProcess {
  readonly pid: number
  readonly process: string
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void }
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  pause(): void
  resume(): void
}

export type PtySpawn = (
  file: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
) => PtyProcess

export interface TerminalSink {
  data(id: string, data: string, ports: ReadonlySet<string>): void
  info(info: TerminalInfo): void
  removed(id: string): void
}

export class TerminalError extends Error {
  constructor(
    readonly code: PortErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface TerminalManagerOptions {
  platform: Platform
  appVersion: string
  env: Environment
  projects: ProjectRegistry
  sink: TerminalSink
  /** Loads node-pty on first use, so a native load failure disables terminals and nothing else. */
  loadPty: () => Promise<PtySpawn>
  findOnPath?: FindOnPath
  warn?: (message: string) => void
  /** Lists the processes attached to a Windows console, the shell's included. */
  consoleProcesses?: (pty: PtyProcess) => Promise<number[] | null>
}

const TITLE_CHECK_MS = 100
const READY_QUIET_MS = 150
const READY_LIMIT_MS = 3000
const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'

interface Terminal {
  info: TerminalInfo
  cwd: string
  shell: ShellSpec
  cols: number
  rows: number
  pty: PtyProcess | null
  generation: number
  replay: ReplayBuffer
  flow: FlowControl
  scanner: OutputScanner
  ports: Set<string>
  pending: string
  batchTimer: NodeJS.Timeout | null
  titleTimer: NodeJS.Timeout | null
  shellProcess: string | null // the foreground process name once the shell is up
  command: TerminalCommand | null // typed once the shell is ready
  readyTimer: NodeJS.Timeout | null
  readyLimit: NodeJS.Timeout | null
}

/** A foreground process as a title: Linux reports argv[0], which may be a path or "-bash". */
function processLabel(raw: string): string {
  return (raw.split(/[\\/]/).pop() ?? '').replace(/^-/, '')
}

/** Owns every pty: spawning, output batching, flow control, replay, titles and exit. */
export class TerminalManager {
  private readonly terminals = new Map<string, Terminal>()
  private shellPath: string | null = null
  private authCommands = new Set<string>()
  private spawnPty: Promise<PtySpawn> | null = null
  private readonly findOnPath: FindOnPath

  constructor(private readonly options: TerminalManagerOptions) {
    this.findOnPath = options.findOnPath ?? pathLookup(options.env, options.platform)
  }

  setShellPath(shellPath: string | null): void {
    this.shellPath = shellPath
  }

  setAuthCommands(commands: string[]): void {
    this.authCommands = new Set(commands)
  }

  async create(port: string, params: TerminalParams<'terminals.create'>): Promise<TerminalInfo> {
    const project = await this.options.projects.match(params.projectPath)
    if (!project) {
      throw new TerminalError('restricted', 'Terminals open only in a known project folder')
    }
    const shell = await resolveShell(
      this.options.platform,
      this.options.env,
      this.shellPath,
      this.findOnPath,
    )
    const terminal: Terminal = {
      info: {
        id: randomUUID(),
        projectPath: project.projectPath,
        shell: shell.name,
        title: shell.name,
        busy: false,
        exitCode: null,
        createdAt: Date.now(),
      },
      cwd: project.cwd,
      shell,
      cols: params.cols,
      rows: params.rows,
      pty: null,
      generation: 0,
      replay: new ReplayBuffer(),
      flow: new FlowControl(),
      scanner: new OutputScanner(),
      ports: new Set([port]),
      pending: '',
      batchTimer: null,
      titleTimer: null,
      shellProcess: null,
      command: params.command ?? null,
      readyTimer: null,
      readyLimit: null,
    }
    await this.spawn(terminal)
    this.terminals.set(terminal.info.id, terminal)
    this.options.sink.info({ ...terminal.info })
    return { ...terminal.info }
  }

  async list(projectPath?: string): Promise<TerminalInfo[]> {
    const all = [...this.terminals.values()].map((terminal) => ({ ...terminal.info }))
    if (projectPath === undefined) return all
    const project = await this.options.projects.match(projectPath)
    return project ? all.filter((info) => info.projectPath === project.projectPath) : []
  }

  /** The output so far, and from now on the terminal's data events, for `port`. */
  attach(port: string, id: string): { replay: string } {
    const terminal = this.get(id)
    this.flush(terminal)
    terminal.ports.add(port)
    return { replay: terminal.replay.snapshot() }
  }

  input(id: string, data: string): void {
    const terminal = this.get(id)
    terminal.pty?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const terminal = this.get(id)
    terminal.cols = cols
    terminal.rows = rows
    terminal.pty?.resize(cols, rows)
  }

  ack(port: string, id: string, chars: number): void {
    const terminal = this.get(id)
    this.applyFlow(terminal, terminal.flow.ack(port, chars))
  }

  kill(id: string): void {
    const terminal = this.get(id)
    this.stopPty(terminal)
    this.terminals.delete(id)
    this.options.sink.removed(id)
  }

  async restart(id: string): Promise<TerminalInfo> {
    const terminal = this.get(id)
    this.stopPty(terminal)
    terminal.shell = await resolveShell(
      this.options.platform,
      this.options.env,
      this.shellPath,
      this.findOnPath,
    )
    Object.assign(terminal.info, {
      shell: terminal.shell.name,
      title: terminal.shell.name,
      busy: false,
      exitCode: null,
    })
    terminal.shellProcess = null
    terminal.flow = new FlowControl()
    await this.spawn(terminal)
    this.options.sink.info({ ...terminal.info })
    return { ...terminal.info }
  }

  /** A port went away: it no longer receives data or holds back a paused pty. */
  detach(port: string): void {
    for (const terminal of this.terminals.values()) {
      if (!terminal.ports.delete(port)) continue
      this.applyFlow(terminal, terminal.flow.removePort(port))
    }
  }

  /** Terminals with a command running, for the quit confirmation. */
  async busy(): Promise<BusyTerminal[]> {
    const live = [...this.terminals.values()].filter((terminal) => terminal.pty)
    const busy = await Promise.all(
      live.map(async (terminal) => {
        if (this.options.platform !== 'win32') return terminal.info.busy
        const attached = await this.options.consoleProcesses?.(terminal.pty!)
        // Without a process list there is no telling; asking is safer than losing work.
        return attached ? attached.length > 1 : true
      }),
    )
    return live
      .filter((_, index) => busy[index])
      .map(({ info }) => ({ id: info.id, projectPath: info.projectPath, title: info.title }))
  }

  dispose(): void {
    for (const terminal of this.terminals.values()) this.stopPty(terminal)
    this.terminals.clear()
  }

  private get(id: string): Terminal {
    const terminal = this.terminals.get(id)
    if (!terminal) throw new TerminalError('not_found', `No terminal "${id}"`)
    return terminal
  }

  private loadPty(): Promise<PtySpawn> {
    this.spawnPty ??= this.options.loadPty().catch((error: unknown) => {
      this.spawnPty = null
      throw new TerminalError('internal', `Terminals are unavailable: ${(error as Error).message}`)
    })
    return this.spawnPty
  }

  private async spawn(terminal: Terminal): Promise<void> {
    const spawnPty = await this.loadPty()
    const generation = ++terminal.generation
    let pty: PtyProcess
    try {
      pty = spawnPty(terminal.shell.file, terminal.shell.args, {
        name: 'xterm-256color',
        cols: terminal.cols,
        rows: terminal.rows,
        cwd: terminal.cwd,
        env: shellEnvironment(this.options.env, this.options.platform, this.options.appVersion),
      })
    } catch (error) {
      throw new TerminalError(
        'internal',
        `Could not start ${terminal.shell.file}: ${(error as Error).message}`,
      )
    }
    terminal.pty = pty
    pty.onData((data) => {
      if (terminal.generation === generation) this.receive(terminal, data)
    })
    pty.onExit(({ exitCode, signal }) => {
      if (terminal.generation === generation) this.exited(terminal, exitCode, signal)
    })
    if (terminal.command) {
      terminal.readyLimit = setTimeout(() => this.typeCommand(terminal), READY_LIMIT_MS)
    }
  }

  private receive(terminal: Terminal, data: string): void {
    terminal.pending += data
    terminal.batchTimer ??= setTimeout(() => this.flush(terminal), TERMINAL_FLOW.batchMs)
  }

  private flush(terminal: Terminal): void {
    if (terminal.batchTimer) clearTimeout(terminal.batchTimer)
    terminal.batchTimer = null
    const data = terminal.pending
    if (data.length === 0) return
    terminal.pending = ''
    terminal.replay.append(data)
    terminal.scanner.scan(data)
    if (terminal.ports.size > 0) {
      this.options.sink.data(terminal.info.id, data, terminal.ports)
      this.applyFlow(terminal, terminal.flow.sent(terminal.ports, data.length))
    }
    terminal.titleTimer ??= setTimeout(() => {
      terminal.titleTimer = null
      this.refreshInfo(terminal)
    }, TITLE_CHECK_MS)
    if (terminal.command) {
      if (terminal.readyTimer) clearTimeout(terminal.readyTimer)
      terminal.readyTimer = setTimeout(() => this.typeCommand(terminal), READY_QUIET_MS)
    }
  }

  private applyFlow(terminal: Terminal, change: 'pause' | 'resume' | null): void {
    if (change === 'pause') terminal.pty?.pause()
    else if (change === 'resume') terminal.pty?.resume()
  }

  private refreshInfo(terminal: Terminal): void {
    const { pty, info } = terminal
    if (!pty || info.exitCode !== null) return
    let title: string
    let busy = info.busy
    if (this.options.platform === 'win32') {
      title = terminal.scanner.title ?? terminal.shell.name
    } else {
      let foreground: string
      try {
        foreground = processLabel(pty.process)
      } catch {
        return
      }
      // The first name seen counts as the shell too: /bin/sh is bash on macOS, for example.
      terminal.shellProcess ??= foreground
      title = foreground || terminal.shell.name
      busy =
        foreground.length > 0 &&
        foreground !== terminal.shell.name &&
        foreground !== terminal.shellProcess
    }
    if (title === info.title && busy === info.busy) return
    info.title = title
    info.busy = busy
    this.options.sink.info({ ...info })
  }

  private typeCommand(terminal: Terminal): void {
    if (terminal.readyTimer) clearTimeout(terminal.readyTimer)
    if (terminal.readyLimit) clearTimeout(terminal.readyLimit)
    terminal.readyTimer = null
    terminal.readyLimit = null
    const { command, pty } = terminal
    terminal.command = null
    if (!command || !pty) return
    if (command.run && this.authCommands.has(command.text)) {
      pty.write(`${command.text}\r`)
      return
    }
    if (!command.text.includes('\n')) {
      pty.write(command.text)
      return
    }
    // Without bracketed paste each newline would run a line; the user must press Enter.
    if (!terminal.scanner.bracketedPaste) {
      this.options.warn?.('Not typing a multi-line command: the shell has no bracketed paste')
      return
    }
    const text = command.text.replace(/\r?\n/g, '\r')
    pty.write(`${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`)
  }

  private exited(terminal: Terminal, exitCode: number, signal: number | undefined): void {
    this.flush(terminal)
    terminal.command = null
    this.clearTimers(terminal)
    terminal.pty = null
    // A shell reports death by signal N as 128 + N.
    terminal.info.exitCode = signal ? 128 + signal : exitCode
    terminal.info.busy = false
    terminal.info.title = terminal.shell.name
    this.options.sink.info({ ...terminal.info })
  }

  private clearTimers(terminal: Terminal): void {
    for (const timer of [
      terminal.batchTimer,
      terminal.titleTimer,
      terminal.readyTimer,
      terminal.readyLimit,
    ]) {
      if (timer) clearTimeout(timer)
    }
    terminal.batchTimer = terminal.titleTimer = terminal.readyTimer = terminal.readyLimit = null
  }

  private stopPty(terminal: Terminal): void {
    terminal.generation++
    this.clearTimers(terminal)
    terminal.pending = ''
    const { pty } = terminal
    terminal.pty = null
    if (!pty) return
    try {
      pty.kill()
    } catch (error) {
      this.options.warn?.(`Could not kill a shell: ${(error as Error).message}`)
    }
  }
}
