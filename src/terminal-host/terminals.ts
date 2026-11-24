import { randomUUID } from 'node:crypto'
import { CONTROL_WAIT_MS, ControlWait, SurfaceControls } from '@shared/control'
import type { BusyTerminal } from '@shared/host-control'
import { t, tEnglish } from '@shared/hosts-text'
import type { Platform } from '@shared/platform'
import type { PortErrorCode } from '@shared/port-rpc'
import {
  replyCommandProblem,
  TERMINAL_QUIET_MS,
  TERMINAL_WAIT_MS,
  type AgentTerminal,
  type TerminalCall,
  type TerminalCallAnswer,
  type TerminalCallErrorCode,
  type TerminalWaitReason,
} from '@shared/terminal-agent'
import type { TerminalCommand, TerminalInfo, TerminalParams } from '@shared/terminal-host'
import { TERMINAL_FLOW, terminalName } from '@shared/terminal-host'
import { commandTitle, typedTitle } from './command-title'
import { DeviceFlow, FlowControl } from './flow'
import { OutputScanner } from './output-scanner'
import { looksLikePasswordPrompt, readsPassword, type TtyModes } from './password'
import { plainTail } from '@shared/terminal-text'
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
  /** The pty's device on macOS and Linux, such as /dev/ttys003. */
  readonly ptsName?: string
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
  /** The message in English, for logs; `message` is in the user's language. */
  readonly log: string

  constructor(
    readonly code: PortErrorCode,
    message: string,
    log = message,
  ) {
    super(message)
    this.log = log
  }
}

/** A terminal of the user's that the agent may not use until they allow it. */
class AskFirst extends Error {
  constructor(readonly terminal: Terminal) {
    super('The user has not allowed this terminal yet')
  }
}

/** The session a terminal serves: the one it belongs to, else the one whose agent started it. */
function sessionOf(terminal: Terminal): string | null {
  return terminal.info.sessionId ?? terminal.info.owner?.sessionId ?? null
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
  /** Reads the arguments of the program in a pty's foreground; titles keep its name when absent. */
  commandLine?: (pty: PtyProcess) => Promise<string[] | null>
  /** Reads a pty's echo and canonical input modes; none are read when absent. */
  ttyModes?: (pty: PtyProcess) => Promise<TtyModes | null>
  now?: () => number
}

const TITLE_CHECK_MS = 100
const READY_QUIET_MS = 150
const READY_LIMIT_MS = 3000
const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'
const CTRL_C = '\x03'
// How long output must stop before the host asks whether the program waits for a password.
const PASSWORD_CHECK_MS = 300
const WAIT_POLL_MS = 200
// A wait that saw no command start in this long finds the terminal idle at its prompt.
const IDLE_AFTER_MS = 1500
// The output kept to read the line the cursor waits on.
const TAIL_CHARS = 1024
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
  program: string | null // the foreground program the title names, while it runs
  command: TerminalCommand | null // typed once the shell is ready
  agentCommand: boolean // the command is an agent's, which runs: Enter follows it
  readyTimer: NodeJS.Timeout | null
  readyLimit: NodeJS.Timeout | null
  /** Resolves once the command is typed, false when it could not be. */
  typed: ((ok: boolean) => void) | null
  tail: string // the latest output, for the line the cursor waits on
  lastOutputAt: number
  quietTimer: NodeJS.Timeout | null
  quietSeq: number // bumped by each output, so a password check that output overtook is dropped
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
        const terminal = this.terminals.get(id)
        const sessionId = terminal ? sessionOf(terminal) : null
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
      return error instanceof TerminalError ? error.log : (error as Error).message
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

  /**
   * Starts a terminal for a window's or device's port, or for an agent when `owner` is set, with
   * the name the agent gave it and the command it runs as its first title.
   */
  private async open(
    params: TerminalParams<'terminals.create'>,
    port: string | null,
    owner: TerminalInfo['owner'],
    naming: { name?: string | null; title?: string } = {},
  ): Promise<TerminalInfo> {
    const project = await this.options.projects.match(params.projectPath)
    if (!project) {
      throw new TerminalError('restricted', t('terminal.unknownProject'))
    }
    const cwd =
      params.folder === undefined
        ? project.cwd
        : await this.options.projects.folderIn(project, params.folder)
    if (cwd === null) {
      throw new TerminalError('restricted', t('terminal.outsideProject'))
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
        title: naming.title || shell.name,
        name: naming.name ?? null,
        namedBy: naming.name ? 'agent' : null,
        busy: false,
        exitCode: null,
        createdAt: Date.now(),
        owner,
        agentAllowed: false,
        control: { kind: 'idle' },
        waiting: null,
      },
      cwd,
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
      program: null,
      command: params.command ?? null,
      agentCommand: owner !== null && params.command !== undefined,
      readyTimer: null,
      readyLimit: null,
      typed: null,
      tail: '',
      lastOutputAt: this.now(),
      quietTimer: null,
      quietSeq: 0,
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

  /**
   * A window's or device's keys: while an agent's turn uses the terminal, only Ctrl+C goes in, and
   * a password its program waits for, which only the user can type.
   */
  input(id: string, data: string): void {
    const terminal = this.get(id)
    if (this.controls.holdsInput(id) && data !== CTRL_C && terminal.info.waiting !== 'password') {
      return
    }
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
      const terminal = this.terminals.get(id)
      if (sessionId === null || !terminal || sessionOf(terminal) === sessionId) {
        this.controls.turnEnded(id)
      }
    }
  }

  /**
   * An agent's tool call. It reaches the terminals its own session started and those of its session
   * the user allowed it, and comes only over main's control channel, never from a window's or
   * device's port. A terminal of the user's it may not use yet answers `ask`.
   */
  async agentCall(call: TerminalCall): Promise<TerminalCallAnswer> {
    try {
      switch (call.kind) {
        case 'run':
          return await this.agentRun(call)
        case 'reply':
          return await this.replyRun(call)
        case 'wait':
          return await this.agentWait(call)
        case 'list':
          return { result: { kind: 'list', terminals: this.sessionTerminals(call.sessionId) } }
        case 'allow':
          return { result: { kind: 'terminal', terminal: this.allow(call) } }
        case 'asking':
          return { result: { kind: 'terminal', terminal: this.asking(call) } }
        case 'rename':
          return { result: this.agentRename(call) }
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
          return await this.agentAct(call, (terminal) => {
            if (!terminal.pty) throw new TerminalError('internal', t('terminal.shellExited'))
            terminal.pty.write(data)
            return { kind: 'terminal', terminal: agentView(terminal) }
          })
        }
        case 'stop':
          return await this.agentAct(call, (terminal) => {
            if (call.close) {
              this.kill(terminal.info.id)
              return { kind: 'closed' }
            }
            terminal.pty?.write(CTRL_C)
            return { kind: 'terminal', terminal: agentView(terminal) }
          })
      }
    } catch (error) {
      if (error instanceof AskFirst) {
        return { result: { kind: 'ask', terminal: agentView(error.terminal) } }
      }
      const code = error instanceof TerminalError ? error.code : null
      return failure(
        code === 'restricted' || code === 'not_found' ? code : 'failed',
        (error as Error).message,
      )
    }
  }

  /** The terminals of `sessionId`, oldest first, as its agent sees them. */
  private sessionTerminals(sessionId: string): AgentTerminal[] {
    return [...this.terminals.values()]
      .filter((terminal) => sessionOf(terminal) === sessionId)
      .sort((a, b) => a.info.createdAt - b.info.createdAt)
      .map(agentView)
  }

  /**
   * Gives or takes back the agent the use of one of its session's terminals the user opened. An
   * agent's own terminal needs no allow, so it is left as it is.
   */
  private allow(call: Extract<TerminalCall, { kind: 'allow' }>): AgentTerminal {
    const terminal = this.terminals.get(call.terminalId)
    if (!terminal || sessionOf(terminal) !== call.sessionId) {
      throw new TerminalError('not_found', t('terminal.noSuchTerminal', { id: call.terminalId }))
    }
    const { info } = terminal
    if (info.owner === null && (info.agentAllowed !== call.allowed || info.agentAsks)) {
      info.agentAllowed = call.allowed
      delete info.agentAsks
      // Taken back while the agent's turn uses it: the user has it again at once.
      if (!call.allowed) this.controls.turnEnded(info.id)
      this.options.sink.info(this.view(terminal))
    }
    return agentView(terminal)
  }

  /**
   * An agent names a tab of its session. A name the user gave, or a terminal of theirs the agent may
   * not use yet, is theirs to change: that answers `ask` unless the call says they agreed.
   */
  private agentRename(
    call: Extract<TerminalCall, { kind: 'rename' }>,
  ): Extract<TerminalCallAnswer, { result: unknown }>['result'] {
    const terminal = this.terminals.get(call.terminalId)
    if (!terminal || sessionOf(terminal) !== call.sessionId) {
      throw new TerminalError('not_found', t('terminal.noSuchTerminal', { id: call.terminalId }))
    }
    const { info } = terminal
    const theirs = info.namedBy === 'user' || (info.owner === null && !info.agentAllowed)
    if (theirs && !call.asked) return { kind: 'ask', terminal: agentView(terminal) }
    this.setName(terminal, call.name, 'agent')
    return { kind: 'terminal', terminal: agentView(terminal) }
  }

  /** The user names a tab from any window or device; an empty name goes back to its title. */
  rename(id: string, name: string): TerminalInfo {
    const terminal = this.get(id)
    this.setName(terminal, name, 'user')
    return this.view(terminal)
  }

  private setName(terminal: Terminal, given: string, by: 'user' | 'agent'): void {
    const named = terminalName(given)
    if ('problem' in named) throw new TerminalError('invalid_params', named.problem)
    const { info } = terminal
    const namedBy = named.name === null ? null : by
    if (info.name === named.name && info.namedBy === namedBy) return
    info.name = named.name
    info.namedBy = namedBy
    this.options.sink.info(this.view(terminal))
  }

  /** Marks a terminal of the user's while a card asks whether the agent may use it. */
  private asking(call: Extract<TerminalCall, { kind: 'asking' }>): AgentTerminal {
    const terminal = this.terminals.get(call.terminalId)
    if (!terminal || sessionOf(terminal) !== call.sessionId) {
      throw new TerminalError('not_found', t('terminal.noSuchTerminal', { id: call.terminalId }))
    }
    const { info } = terminal
    if (info.owner === null && !!info.agentAsks !== call.asking) {
      if (call.asking) info.agentAsks = true
      else delete info.agentAsks
      this.options.sink.info(this.view(terminal))
    }
    return agentView(terminal)
  }

  private async agentRun(
    call: Extract<TerminalCall, { kind: 'run' }>,
  ): Promise<TerminalCallAnswer> {
    if (call.command.length === 0 || AGENT_CONTROL.test(call.command)) {
      return failure('failed', 'The command must be one line without control characters')
    }
    const named = terminalName(call.name ?? '')
    if ('problem' in named) return failure('failed', named.problem)
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
      { name: named.name, title: typedTitle(call.command) },
    )
    // A new terminal is the turn's from the start, so the user's first keys are held back too.
    const end = await this.controls.begin(info.id, { deadline: this.now() + CONTROL_WAIT_MS })
    end()
    return { result: { kind: 'terminal', terminal: agentView(this.get(info.id)) } }
  }

  /**
   * The user's Run on a code block of the agent's reply: the terminal is the agent's, for its tools
   * to follow, but no turn uses it, so the user's keys go in. A block of several lines goes in one
   * bracketed paste, so a prompt on the way cannot read the lines after it as its answer.
   */
  private async replyRun(
    call: Extract<TerminalCall, { kind: 'reply' }>,
  ): Promise<TerminalCallAnswer> {
    const problem = replyCommandProblem(call.command)
    if (problem) {
      const why = t(`terminal.blockProblem.${problem}`)
      return failure('failed', t('terminal.blockCannotRun', { problem: why }))
    }
    const command = call.command.replace(/\r?\n$/, '')
    const info = await this.open(
      {
        projectPath: call.folder,
        sessionId: call.sessionId,
        cols: 100,
        rows: 24,
        command: { text: command, run: true },
      },
      null,
      { agentId: call.agentId, sessionId: call.sessionId, fromReply: true },
      { title: typedTitle(command) },
    )
    const terminal = this.get(info.id)
    const typed = await new Promise<boolean>((resolve) => {
      if (!terminal.command) resolve(terminal.pty !== null)
      else terminal.typed = resolve
    })
    if (!typed) {
      this.kill(info.id)
      return failure('failed', t('terminal.noBracketedPaste'))
    }
    return { result: { kind: 'terminal', terminal: agentView(this.get(info.id)) } }
  }

  /**
   * Waits on a terminal the session reaches until its command ends, it waits for a password or its
   * output stays quiet, at most TERMINAL_WAIT_MS, and answers its output then and why.
   */
  private async agentWait(
    call: Extract<TerminalCall, { kind: 'wait' }>,
  ): Promise<TerminalCallAnswer> {
    const started = this.now()
    let sawBusy = false
    let reason: TerminalWaitReason
    for (;;) {
      const terminal = this.owned(call.sessionId, call.terminalId)
      const { info } = terminal
      const now = this.now()
      // Windows tells no foreground process, so there a command's end shows only as quiet.
      const knowsBusy = this.options.platform !== 'win32'
      sawBusy ||= info.busy
      if (info.exitCode !== null) reason = 'exited'
      else if (info.waiting === 'password') reason = 'password'
      else if (knowsBusy && sawBusy && !info.busy) reason = 'ended'
      else if (
        knowsBusy &&
        !sawBusy &&
        !terminal.command &&
        now - started >= IDLE_AFTER_MS &&
        now - terminal.lastOutputAt >= IDLE_AFTER_MS
      ) {
        reason = 'idle'
      } else if (
        now - started >= TERMINAL_QUIET_MS &&
        now - terminal.lastOutputAt >= TERMINAL_QUIET_MS
      ) {
        reason = 'quiet'
      } else if (now - started >= TERMINAL_WAIT_MS) reason = 'timeout'
      else {
        await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS))
        continue
      }
      this.flush(terminal)
      const output = plainTail(terminal.replay.snapshot(), call.lines)
      return { result: { kind: 'output', terminal: agentView(terminal), output, reason } }
    }
  }

  /**
   * Acts on an agent's own terminal once the user does not hold it, or answers `held`; while its
   * program waits for a password the user types, the call waits too, or answers `password`, unless
   * the user lets agents type passwords.
   */
  private async agentAct(
    call: Extract<TerminalCall, { kind: 'input' | 'stop' }>,
    act: (terminal: Terminal) => Extract<TerminalCallAnswer, { result: unknown }>['result'],
  ): Promise<TerminalCallAnswer> {
    const { sessionId, terminalId: id } = call
    if (call.readOnly && this.owned(sessionId, id).info.owner === null) {
      return failure(
        'not_allowed',
        "The session plans, so it may only read the user's terminal, not type into or stop it",
      )
    }
    const deadline = this.now() + CONTROL_WAIT_MS
    while (!call.passwords && this.terminals.get(id)?.info.waiting === 'password') {
      if (this.now() >= deadline) return { result: { kind: 'password' } }
      await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS))
    }
    this.owned(sessionId, id)
    let end: () => void
    try {
      end = await this.controls.begin(id, { deadline })
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

  /**
   * A terminal `sessionId`'s agent may use: one it started, or one of its session the user allowed
   * it. One of its session's the user has not allowed yet throws AskFirst; any other reads as
   * missing.
   */
  private owned(sessionId: string, id: string): Terminal {
    const terminal = this.terminals.get(id)
    if (!terminal || sessionOf(terminal) !== sessionId) {
      throw new TerminalError('not_found', t('terminal.noSuchTerminal', { id }))
    }
    if (terminal.info.owner === null && !terminal.info.agentAllowed) throw new AskFirst(terminal)
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
    // The name the user or the agent gave the tab stays; the new shell has run nothing yet.
    Object.assign(terminal.info, {
      shell: terminal.shell.name,
      title: terminal.shell.name,
      busy: false,
      exitCode: null,
      owner: null,
      agentAllowed: false,
      waiting: null,
    })
    delete terminal.info.agentAsks
    // The new shell is the user's: no agent started it, and the user allowed none to use it yet.
    this.controls.forget(id)
    terminal.agentCommand = false
    terminal.shellProcess = null
    terminal.program = null
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
    if (!terminal) throw new TerminalError('not_found', t('terminal.terminalGone', { id }))
    return terminal
  }

  private loadPty(): Promise<PtySpawn> {
    this.spawnPty ??= this.options.loadPty().catch((error: unknown) => {
      this.spawnPty = null
      const reason = (error as Error).message
      throw new TerminalError(
        'internal',
        t('terminal.unavailable', { reason }),
        tEnglish('terminal.unavailable', { reason }),
      )
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
      const params = { shell: terminal.shell.file, reason: (error as Error).message }
      throw new TerminalError(
        'internal',
        t('terminal.startFailed', params),
        tEnglish('terminal.startFailed', params),
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
    this.outputArrived(terminal, data)
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

  /** New output answers any password prompt; once it stops, asks whether another waits. */
  private outputArrived(terminal: Terminal, data: string): void {
    terminal.tail = (terminal.tail + data).slice(-TAIL_CHARS)
    terminal.lastOutputAt = this.now()
    terminal.quietSeq++
    if (terminal.info.waiting !== null) {
      terminal.info.waiting = null
      this.options.sink.info(this.view(terminal))
    }
    if (terminal.quietTimer) clearTimeout(terminal.quietTimer)
    terminal.quietTimer = setTimeout(() => {
      terminal.quietTimer = null
      void this.checkPassword(terminal)
    }, PASSWORD_CHECK_MS)
  }

  private async checkPassword(terminal: Terminal): Promise<void> {
    const { pty } = terminal
    const seq = terminal.quietSeq
    // A prompt leaves the cursor after its words; a program that printed whole lines asks nothing.
    const line = plainTail(terminal.tail.slice(terminal.tail.lastIndexOf('\n') + 1), 1)
    if (!pty || terminal.info.exitCode !== null || !line) return
    let waits: boolean
    if (this.options.platform === 'win32') {
      waits = looksLikePasswordPrompt(line)
    } else {
      this.refreshInfo(terminal)
      if (!terminal.info.busy || !this.options.ttyModes) return
      const modes = await this.options.ttyModes(pty)
      waits = modes !== null && readsPassword(modes)
    }
    if (!waits || terminal.quietSeq !== seq || terminal.pty !== pty) return
    terminal.info.waiting = 'password'
    this.options.sink.info(this.view(terminal))
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
      busy =
        foreground.length > 0 &&
        foreground !== terminal.shell.name &&
        foreground !== terminal.shellProcess
      // A program names the tab while it runs and after it ends, until the next one.
      title = info.title
      if (!busy) terminal.program = null
      else if (terminal.program !== foreground) {
        terminal.program = foreground
        title = foreground
        void this.readProgram(terminal, pty, foreground)
      }
    }
    if (title === info.title && busy === info.busy) return
    info.title = title
    info.busy = busy
    this.options.sink.info(this.view(terminal))
  }

  /** Titles the tab with the foreground program's command line, once it is read. */
  private async readProgram(terminal: Terminal, pty: PtyProcess, program: string): Promise<void> {
    const argv = await this.options.commandLine?.(pty)
    const title = argv ? commandTitle(argv) : null
    if (!title || terminal.pty !== pty || terminal.program !== program) return
    if (title === terminal.info.title) return
    terminal.info.title = title
    this.options.sink.info(this.view(terminal))
  }

  private typeCommand(terminal: Terminal): void {
    if (terminal.readyTimer) clearTimeout(terminal.readyTimer)
    if (terminal.readyLimit) clearTimeout(terminal.readyLimit)
    terminal.readyTimer = null
    terminal.readyLimit = null
    const { command, pty, typed } = terminal
    terminal.command = null
    terminal.typed = null
    if (!command || !pty) {
      typed?.(false)
      return
    }
    if (terminal.agentCommand && command.text.includes('\n')) {
      const ok = terminal.scanner.bracketedPaste
      if (ok) {
        const text = command.text.replace(/\r?\n/g, '\r')
        pty.write(`${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}\r`)
      }
      typed?.(ok)
      return
    }
    if (terminal.agentCommand || (command.run && this.authCommands.has(command.text))) {
      pty.write(`${command.text}\r`)
      typed?.(true)
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
    terminal.info.waiting = null
    terminal.info.title = terminal.shell.name
    this.options.sink.info(this.view(terminal))
  }

  private clearTimers(terminal: Terminal): void {
    for (const timer of [
      terminal.batchTimer,
      terminal.titleTimer,
      terminal.readyTimer,
      terminal.readyLimit,
      terminal.quietTimer,
    ]) {
      if (timer) clearTimeout(timer)
    }
    terminal.batchTimer = terminal.titleTimer = terminal.readyTimer = terminal.readyLimit = null
    terminal.quietTimer = null
    terminal.typed?.(false)
    terminal.typed = null
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
  const { id, title, name, namedBy, busy, exitCode, waiting, owner, agentAllowed } = terminal.info
  return {
    id,
    title,
    name,
    namedBy,
    busy,
    exitCode,
    password: waiting === 'password',
    opener: owner === null ? 'user' : owner.fromReply ? 'reply' : 'agent',
    usable: owner !== null || agentAllowed,
  }
}

function failure(code: TerminalCallErrorCode, message: string): TerminalCallAnswer {
  return { error: { code, message } }
}
