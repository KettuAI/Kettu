import { randomUUID } from 'node:crypto'
import { CONTROL_WAIT_MS, ControlWait, SurfaceControls } from '@shared/control'
import type { BusyTerminal } from '@shared/host-control'
import type { Platform } from '@shared/platform'
import type { PortErrorCode } from '@shared/port-rpc'
import type {
  AgentTerminal,
  TerminalCall,
  TerminalCallAnswer,
  TerminalCallErrorCode,
} from '@shared/terminal-agent'
import type { TerminalCommand, TerminalInfo, TerminalParams } from '@shared/terminal-host'
import { TERMINAL_FLOW } from '@shared/terminal-host'
import { DeviceFlow, FlowControl } from './flow'
import { OutputScanner } from './output-scanner'
import { plainTail } from './plain-text'
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
  data(id: string, data: string, ports: Iterable<string>): void
  /** A device's port caught up after it fell behind: its screen starts over from `replay`. */
  replay(id: string, port: string, replay: string): void
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
  /** Whether a port serves a paired device, which never pauses the pty; none do when absent. */
  isDevicePort?: (port: string) => boolean
  /** The user handed back a terminal an agent's turn uses, after holding it for `durationMs`. */
  handedBack?: (sessionId: string, durationMs: number) => void
  now?: () => number
}

const TITLE_CHECK_MS = 100
const READY_QUIET_MS = 150
const READY_LIMIT_MS = 3000
const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'
const CTRL_C = '\x03'
// An agent's command and text are typed as they are; a control character could act as a key.
// eslint-disable-next-line no-control-regex
const AGENT_CONTROL = /[\x00-\x08\x0a-\x1f\x7f]/

interface Terminal {
  info: TerminalInfo
  cwd: string
  shell: ShellSpec
  cols: number
  rows: number
  pty: PtyProcess | null
  generation: number
  replay: ReplayBuffer
  flow: FlowControl // windows' ports
  devices: DeviceFlow // devices' ports
  scanner: OutputScanner
  ports: Set<string>
  pending: string
  batchTimer: NodeJS.Timeout | null
  titleTimer: NodeJS.Timeout | null
  shellProcess: string | null // the foreground name at the shell's first output
  command: TerminalCommand | null // typed once the shell is ready
  agentCommand: boolean // the command is an agent's, which runs: Enter follows it
  readyTimer: NodeJS.Timeout | null
  readyLimit: NodeJS.Timeout | null
}

/**
 * The terminal's foreground process as a title, or null when it cannot be read. Linux reports
 * argv[0], which may be a path or "-bash"; macOS reports the short process name.
 */
function foregroundName(pty: PtyProcess | null): string | null {
  let raw: unknown
  try {
    raw = pty?.process
  } catch {
    return null
  }
  if (typeof raw !== 'string') return null
  return (raw.split(/[\\/]/).pop() ?? '').replace(/^-/, '')
}

/**
 * Windows shells title the console with their executable's path, often behind a prefix such as
 * "Administrator: "; the tab shows the program's name instead, as it does on macOS and Linux.
 */
function programTitle(title: string): string {
  return /(?:^|[\\/]|:\s+)([^\\/:]+)\.exe$/i.exec(title)?.[1] ?? title
}

/** Owns every pty: spawning, output batching, flow control, replay, titles and exit. */
export class TerminalManager {
  private readonly terminals = new Map<string, Terminal>()
  private shellPath: string | null = null
  private authCommands = new Set<string>()
  private spawnPty: Promise<PtySpawn> | null = null
  private readonly findOnPath: FindOnPath
  // Who uses each terminal an agent started, by terminal id, for the owner's running turn.
  private readonly controls: SurfaceControls

  constructor(private readonly options: TerminalManagerOptions) {
    this.findOnPath = options.findOnPath ?? pathLookup(options.env, options.platform)
    this.controls = new SurfaceControls({
      changed: (id) => {
        const terminal = this.terminals.get(id)
        if (terminal) this.options.sink.info(this.view(terminal))
      },
      handedBack: (id, durationMs) => {
        const sessionId = this.terminals.get(id)?.info.owner?.sessionId
        if (sessionId) this.options.handedBack?.(sessionId, durationMs)
      },
      now: options.now,
    })
  }

  /** Loads node-pty ahead of the first terminal; resolves to why it cannot load, or null. */
  async warmUp(): Promise<string | null> {
    try {
      await this.loadPty()
      return null
    } catch (error) {
      return (error as Error).message
    }
  }

  setShellPath(shellPath: string | null): void {
    this.shellPath = shellPath
  }

  setAuthCommands(commands: string[]): void {
    this.authCommands = new Set(commands)
  }

  create(port: string, params: TerminalParams<'terminals.create'>): Promise<TerminalInfo> {
    return this.open(params, port, null)
  }

  /** Starts a terminal for a window's or device's port, or for an agent when `owner` is set. */
  private async open(
    params: TerminalParams<'terminals.create'>,
    port: string | null,
    owner: TerminalInfo['owner'],
  ): Promise<TerminalInfo> {
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
        sessionId: params.sessionId ?? null,
        shell: shell.name,
        title: shell.name,
        busy: false,
        exitCode: null,
        createdAt: Date.now(),
        owner,
        control: { kind: 'idle' },
      },
      cwd: project.cwd,
      shell,
      cols: params.cols,
      rows: params.rows,
      pty: null,
      generation: 0,
      replay: new ReplayBuffer(),
      flow: new FlowControl(),
      devices: new DeviceFlow(),
      scanner: new OutputScanner(),
      ports: new Set(port === null ? [] : [port]),
      pending: '',
      batchTimer: null,
      titleTimer: null,
      shellProcess: null,
      command: params.command ?? null,
      agentCommand: owner !== null && params.command !== undefined,
      readyTimer: null,
      readyLimit: null,
    }
    await this.spawn(terminal)
    this.terminals.set(terminal.info.id, terminal)
    this.options.sink.info(this.view(terminal))
    return this.view(terminal)
  }

  async list(projectPath?: string): Promise<TerminalInfo[]> {
    const all = [...this.terminals.values()].map((terminal) => this.view(terminal))
    if (projectPath === undefined) return all
    const project = await this.options.projects.match(projectPath)
    return project ? all.filter((info) => info.projectPath === project.projectPath) : []
  }

  /** Hands the project's terminals that belong to no session yet to `sessionId`. */
  async assign(projectPath: string, sessionId: string): Promise<void> {
    const project = await this.options.projects.match(projectPath)
    if (!project) return
    for (const terminal of this.terminals.values()) {
      if (terminal.info.projectPath !== project.projectPath || terminal.info.sessionId !== null) {
        continue
      }
      terminal.info.sessionId = sessionId
      this.options.sink.info(this.view(terminal))
    }
  }

  /** Ends the terminals of sessions that were archived or deleted. */
  endSessions(sessionIds: readonly string[]): void {
    const ended = new Set(sessionIds)
    for (const terminal of [...this.terminals.values()]) {
      if (terminal.info.sessionId !== null && ended.has(terminal.info.sessionId)) {
        this.kill(terminal.info.id)
      }
    }
  }

  /** The output so far, and from now on the terminal's data events, for `port`. */
  attach(port: string, id: string): { replay: string } {
    const terminal = this.get(id)
    this.flush(terminal)
    terminal.ports.add(port)
    if (this.isDevice(port)) terminal.devices.reset(port)
    return { replay: terminal.replay.snapshot() }
  }

  /** A window's or device's keys: while an agent's turn uses the terminal, only Ctrl+C goes in. */
  input(id: string, data: string): void {
    const terminal = this.get(id)
    if (this.controls.holdsInput(id) && data !== CTRL_C) return
    terminal.pty?.write(data)
  }

  /** The user's Take over; false when no agent's turn uses the terminal. */
  takeOver(id: string): boolean {
    this.get(id)
    return this.controls.takeOver(id)
  }

  /** The user's Hand back: the agent's waiting calls go on. */
  handBack(id: string): boolean {
    this.get(id)
    return this.controls.handBack(id)
  }

  /** The turn of `sessionId` ended, or every turn when null: its terminals are nobody's now. */
  turnEnded(sessionId: string | null): void {
    for (const id of this.controls.keys()) {
      const owner = this.terminals.get(id)?.info.owner
      if (sessionId === null || !owner || owner.sessionId === sessionId) {
        this.controls.turnEnded(id)
      }
    }
  }

  /**
   * An agent's tool call. It reaches only terminals its own session started, and comes only over
   * main's control channel, never from a window's or device's port.
   */
  async agentCall(call: TerminalCall): Promise<TerminalCallAnswer> {
    try {
      switch (call.kind) {
        case 'run':
          return await this.agentRun(call)
        case 'read': {
          const terminal = this.owned(call.sessionId, call.terminalId)
          this.flush(terminal)
          const output = plainTail(terminal.replay.snapshot(), call.lines)
          return { result: { kind: 'output', terminal: agentView(terminal), output } }
        }
        case 'input': {
          if (AGENT_CONTROL.test(call.text)) {
            return failure('failed', 'The text must not contain control characters')
          }
          const data = call.enter ? `${call.text}\r` : call.text
          return await this.agentAct(call.sessionId, call.terminalId, (terminal) => {
            if (!terminal.pty) throw new TerminalError('internal', 'The shell has exited')
            terminal.pty.write(data)
            return { kind: 'terminal', terminal: agentView(terminal) }
          })
        }
        case 'stop':
          return await this.agentAct(call.sessionId, call.terminalId, (terminal) => {
            if (call.close) {
              this.kill(terminal.info.id)
              return { kind: 'closed' }
            }
            terminal.pty?.write(CTRL_C)
            return { kind: 'terminal', terminal: agentView(terminal) }
          })
      }
    } catch (error) {
      const code = error instanceof TerminalError ? error.code : null
      return failure(
        code === 'restricted' || code === 'not_found' ? code : 'failed',
        (error as Error).message,
      )
    }
  }

  private async agentRun(
    call: Extract<TerminalCall, { kind: 'run' }>,
  ): Promise<TerminalCallAnswer> {
    if (call.command.length === 0 || AGENT_CONTROL.test(call.command)) {
      return failure('failed', 'The command must be one line without control characters')
    }
    const info = await this.open(
      {
        projectPath: call.folder,
        sessionId: call.sessionId,
        cols: 100,
        rows: 24,
        command: { text: call.command, run: true },
      },
      null,
      { agentId: call.agentId, sessionId: call.sessionId },
    )
    // A new terminal is the turn's from the start, so the user's first keys are held back too.
    const end = await this.controls.begin(info.id, { deadline: this.now() + CONTROL_WAIT_MS })
    end()
    return { result: { kind: 'terminal', terminal: agentView(this.get(info.id)) } }
  }

  /** Acts on an agent's own terminal once the user does not hold it, or answers `held`. */
  private async agentAct(
    sessionId: string,
    id: string,
    act: (terminal: Terminal) => Extract<TerminalCallAnswer, { result: unknown }>['result'],
  ): Promise<TerminalCallAnswer> {
    this.owned(sessionId, id)
    let end: () => void
    try {
      end = await this.controls.begin(id, { deadline: this.now() + CONTROL_WAIT_MS })
    } catch (error) {
      if (!(error instanceof ControlWait)) throw error
      if (error.reason === 'held' || error.reason === 'asking') return { result: { kind: 'held' } }
      return failure('stopped', 'The turn ended before the user handed the terminal back')
    }
    try {
      return { result: act(this.owned(sessionId, id)) }
    } finally {
      end()
    }
  }

  /** A terminal `sessionId`'s agent started; any other reads as missing. */
  private owned(sessionId: string, id: string): Terminal {
    const terminal = this.terminals.get(id)
    if (!terminal || terminal.info.owner?.sessionId !== sessionId) {
      throw new TerminalError('not_found', `This session started no terminal "${id}"`)
    }
    return terminal
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /** The terminal's info as clients see it, with who uses it now. */
  private view(terminal: Terminal): TerminalInfo {
    return { ...terminal.info, control: this.controls.state(terminal.info.id) }
  }

  resize(id: string, cols: number, rows: number): void {
    const terminal = this.get(id)
    terminal.cols = cols
    terminal.rows = rows
    terminal.pty?.resize(cols, rows)
  }

  ack(port: string, id: string, chars: number): void {
    const terminal = this.get(id)
    if (!this.isDevice(port)) {
      this.applyFlow(terminal, terminal.flow.ack(port, chars))
      return
    }
    // Output still batched is not in the replay; it reaches the port as data once flushed.
    if (terminal.devices.ack(port, chars) && terminal.ports.has(port)) {
      this.options.sink.replay(id, port, terminal.replay.snapshot())
    }
  }

  kill(id: string): void {
    const terminal = this.get(id)
    this.stopPty(terminal)
    this.terminals.delete(id)
    this.controls.forget(id)
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
      owner: null,
    })
    // The new shell is the user's: no agent started it.
    this.controls.forget(id)
    terminal.agentCommand = false
    terminal.shellProcess = null
    terminal.flow = new FlowControl()
    terminal.devices = new DeviceFlow()
    await this.spawn(terminal)
    this.options.sink.info(this.view(terminal))
    return this.view(terminal)
  }

  /** A port went away: it no longer receives data or holds back a paused pty. */
  detach(port: string): void {
    for (const terminal of this.terminals.values()) {
      if (!terminal.ports.delete(port)) continue
      terminal.devices.removePort(port)
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

  private isDevice(port: string): boolean {
    return this.options.isDevicePort?.(port) ?? false
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
    // The first output comes from the shell once it runs, before anything typed can start a
    // command; the name in the foreground then is the shell's own (bash when /bin/sh is bash).
    if (terminal.shellProcess === null && this.options.platform !== 'win32') {
      terminal.shellProcess = foregroundName(terminal.pty) ?? ''
    }
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
      const windows: string[] = []
      const devices: string[] = []
      for (const port of terminal.ports) (this.isDevice(port) ? devices : windows).push(port)
      const receiving = [...windows, ...terminal.devices.sent(devices, data.length)]
      if (receiving.length > 0) this.options.sink.data(terminal.info.id, data, receiving)
      this.applyFlow(terminal, terminal.flow.sent(windows, data.length))
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
      const shellTitle = terminal.scanner.title
      title = shellTitle ? programTitle(shellTitle) : terminal.shell.name
    } else {
      const foreground = foregroundName(pty)
      if (foreground === null) return
      title = foreground || terminal.shell.name
      busy =
        foreground.length > 0 &&
        foreground !== terminal.shell.name &&
        foreground !== terminal.shellProcess
    }
    if (title === info.title && busy === info.busy) return
    info.title = title
    info.busy = busy
    this.options.sink.info(this.view(terminal))
  }

  private typeCommand(terminal: Terminal): void {
    if (terminal.readyTimer) clearTimeout(terminal.readyTimer)
    if (terminal.readyLimit) clearTimeout(terminal.readyLimit)
    terminal.readyTimer = null
    terminal.readyLimit = null
    const { command, pty } = terminal
    terminal.command = null
    if (!command || !pty) return
    if (terminal.agentCommand || (command.run && this.authCommands.has(command.text))) {
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
    this.options.sink.info(this.view(terminal))
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

function agentView(terminal: Terminal): AgentTerminal {
  const { id, title, busy, exitCode } = terminal.info
  return { id, title, busy, exitCode }
}

function failure(code: TerminalCallErrorCode, message: string): TerminalCallAnswer {
  return { error: { code, message } }
}
