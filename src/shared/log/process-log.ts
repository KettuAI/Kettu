// This process's log: one JSON record per line in its own rotating file, every line redacted
// first. Main, each host and the daemon open one; records written before it opens are kept and
// written once it does.

import { AsyncLocalStorage } from 'node:async_hooks'
import os from 'node:os'
import { createRedactor, type Redactor } from './redact'
import { pruneLogFolder, RotatingFile } from './rotating-file'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const MB = 1024 * 1024
const DAY_MS = 24 * 60 * 60 * 1000

export const LOG_LIMITS = {
  fileBytes: 10 * MB,
  files: 5,
  agentBytes: 5 * MB,
  agentFiles: 2,
  verboseBytes: 10 * MB,
  verboseFiles: 3,
  maxAgeMs: 14 * DAY_MS,
  verboseAgeMs: 3 * DAY_MS,
  folderBytes: 500 * MB,
  linesPerMinute: 600,
  messageChars: 64 * 1024,
}

/** Detailed records, which hold agents' messages, are in files named with this prefix. */
export const VERBOSE_PREFIX = 'verbose-'

// What a parent passes to a host it forks, so the host logs from its first line.
const ENV_DIR = 'KETTU_LOG_DIR'
const ENV_LEVEL = 'KETTU_LOG_LEVEL'
const ENV_VERBOSE = 'KETTU_LOG_VERBOSE'
const ENV_ECHO = 'KETTU_LOG_ECHO'

const BEFORE_OPEN_LIMIT = 1000
const MAX_SECRETS = 256
const MINUTE_MS = 60_000

export interface ProcessLogOptions {
  dir: string
  /** The process's name, which is also its file's: main, agent-host, daemon. */
  name: string
  level?: LogLevel
  /** Whether detailed records are written, which the debug level alone does not turn on. */
  verbose?: boolean
  /** Also prints each record, for a terminal or a development run. */
  echo?: boolean
  /** Whether this process prunes the folder; one process per folder does. */
  prune?: boolean
}

interface Rate {
  windowStart: number
  count: number
  dropped: number
}

const operations = new AsyncLocalStorage<string>()
const secrets = new Set<string>()
const rates = new Map<string, Rate>()
const sideFiles = new Map<string, RotatingFile>()
const beforeOpen: { record: Record<string, unknown>; urgent: boolean }[] = []
const original = { log: console.log.bind(console) }

let processName = 'process'
let dir: string | null = null
let file: RotatingFile | null = null
let level: LogLevel = 'info'
let verbose = false
let echo = true
let prunes = false
let pruning: Promise<void> | null = null
let redact: Redactor = createRedactor({ home: os.homedir(), secrets: () => secrets })

export function openProcessLog(options: ProcessLogOptions): void {
  if (file) return
  processName = options.name
  dir = options.dir
  level = options.level ?? 'info'
  verbose = options.verbose ?? false
  echo = options.echo ?? false
  prunes = options.prune ?? false
  file = new RotatingFile({
    dir: options.dir,
    name: options.name,
    maxBytes: LOG_LIMITS.fileBytes,
    files: LOG_LIMITS.files,
    onRotate: prune,
  })
  for (const { record, urgent } of beforeOpen.splice(0)) {
    file.write(serialize({ ...record, process: processName }), urgent)
  }
  prune()
  process.once('exit', flushLogSync)
}

/** Opens the log a parent named in the environment, and removes those variables from it. */
export function openProcessLogFromEnv(name: string): void {
  const logDir = process.env[ENV_DIR]
  const envLevel = process.env[ENV_LEVEL]
  const envVerbose = process.env[ENV_VERBOSE] === '1'
  const envEcho = process.env[ENV_ECHO] === '1'
  // Agents and shells get this process's environment; these are not theirs.
  delete process.env[ENV_DIR]
  delete process.env[ENV_LEVEL]
  delete process.env[ENV_VERBOSE]
  delete process.env[ENV_ECHO]
  echo = envEcho
  if (!logDir) return
  openProcessLog({
    dir: logDir,
    name,
    level: isLevel(envLevel) ? envLevel : 'info',
    verbose: envVerbose,
    echo: envEcho,
  })
}

/** The variables that make a forked host log into `logDir` from its first line. */
export function logEnvironment(): Record<string, string> {
  if (!dir) return {}
  return {
    [ENV_DIR]: dir,
    [ENV_LEVEL]: level,
    ...(verbose ? { [ENV_VERBOSE]: '1' } : {}),
    ...(echo ? { [ENV_ECHO]: '1' } : {}),
  }
}

export function logFolder(): string | null {
  return dir
}

function isLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && value in RANK
}

export function setLogLevel(next: LogLevel): void {
  level = next
}

export function logLevel(): LogLevel {
  return level
}

/** Turns detailed records, which hold agents' messages, on or off; off closes their files. */
export function setVerboseRecords(on: boolean): void {
  const was = verbose
  verbose = on
  if (was && !on) closeVerboseLogs()
}

export function verboseRecords(): boolean {
  return verbose
}

/**
 * A value to mask wherever it appears in this process's log, such as a token it holds. The
 * newest are kept: an old token is no longer valid, and each one costs every record a scan.
 */
export function addLogSecret(value: string): void {
  if (!value) return
  secrets.delete(value)
  secrets.add(value)
  if (secrets.size > MAX_SECRETS) secrets.delete(secrets.values().next().value!)
}

export function removeLogSecret(value: string): void {
  secrets.delete(value)
}

/** Text masked as this process masks its log, with the secrets it holds now. */
export function redactLogText(text: string): string {
  return redact(text)
}

/** Only for tests: a redactor with a fixed home folder. */
export function setLogRedactorForTests(next: Redactor): void {
  redact = next
}

/** Runs `run` so that every record it writes, also after awaits, carries the operation `id`. */
export function withOperation<T>(id: string, run: () => T): T {
  return operations.run(id, run)
}

export function currentOperation(): string | undefined {
  return operations.getStore()
}

export function writeLog(
  recordLevel: LogLevel,
  source: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (RANK[recordLevel] < RANK[level]) return
  if (!admit(source)) return
  const op = operations.getStore()
  const record: Record<string, unknown> = {
    time: new Date().toISOString(),
    level: recordLevel,
    process: processName,
    source,
    message:
      message.length > LOG_LIMITS.messageChars
        ? `${message.slice(0, LOG_LIMITS.messageChars)}... (${message.length} chars)`
        : message,
  }
  if (op) record['op'] = op
  if (data && Object.keys(data).length > 0) record['data'] = data
  emit(record, recordLevel === 'error')
  if (echo) {
    // Always stdout: a parent reads a host's stderr as failure output and logs it itself.
    original.log(`[${String(record['time'])}] [${recordLevel}] [${source}] ${message}`)
  }
}

function serialize(record: Record<string, unknown>): string {
  let json: string
  try {
    json = JSON.stringify(record)
  } catch {
    json = JSON.stringify({ ...record, data: '<unserializable>' })
  }
  return `${redact(json)}\n`
}

function emit(record: Record<string, unknown>, urgent: boolean): void {
  if (file) {
    file.write(serialize(record), urgent)
    return
  }
  beforeOpen.push({ record, urgent })
  if (beforeOpen.length > BEFORE_OPEN_LIMIT) beforeOpen.shift()
}

/** Whether `source` may write now; a source past its rate is cut off for the rest of the minute. */
function admit(source: string): boolean {
  const now = Date.now()
  let rate = rates.get(source)
  if (!rate || now - rate.windowStart >= MINUTE_MS) {
    const dropped = rate?.dropped ?? 0
    rate = { windowStart: now, count: 0, dropped: 0 }
    rates.set(source, rate)
    if (dropped > 0) {
      rate.count++
      emit(
        {
          time: new Date(now).toISOString(),
          level: 'warn',
          process: processName,
          source,
          message: `Dropped ${dropped} lines in the last minute`,
        },
        false,
      )
    }
  }
  if (rate.count >= LOG_LIMITS.linesPerMinute) {
    rate.dropped++
    return false
  }
  rate.count++
  return true
}

export interface SideLog {
  /** Writes one record; `message` is raw JSON when `json` is true. */
  write(source: string, message: string, data?: Record<string, unknown>): void
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_')
}

/**
 * A file of its own beside this process's, such as an agent's stderr (`kind` agent) or its
 * protocol traffic while detailed records are on (`kind` verbose).
 */
export function sideLog(kind: 'agent' | 'verbose', name: string): SideLog {
  const fileName = `${kind === 'verbose' ? VERBOSE_PREFIX : ''}${safeName(name)}`
  return {
    write: (source, message, data) => {
      if (!dir) return
      if (kind === 'verbose' && !verbose) return
      if (!admit(`${fileName}:${source}`)) return
      let side = sideFiles.get(fileName)
      if (!side) {
        side = new RotatingFile({
          dir,
          name: fileName,
          maxBytes: kind === 'verbose' ? LOG_LIMITS.verboseBytes : LOG_LIMITS.agentBytes,
          files: kind === 'verbose' ? LOG_LIMITS.verboseFiles : LOG_LIMITS.agentFiles,
        })
        sideFiles.set(fileName, side)
      }
      const record: Record<string, unknown> = {
        time: new Date().toISOString(),
        level: 'info',
        process: processName,
        source,
        message,
      }
      const op = operations.getStore()
      if (op) record['op'] = op
      if (data && Object.keys(data).length > 0) record['data'] = data
      side.write(serialize(record))
    },
  }
}

/** Closes the detailed records' files, which stop growing once detailed records are off. */
export function closeVerboseLogs(): void {
  for (const [name, side] of sideFiles) {
    if (!name.startsWith(VERBOSE_PREFIX)) continue
    sideFiles.delete(name)
    void side.close()
  }
}

export function flushLogSync(): void {
  file?.flushSync()
  for (const side of sideFiles.values()) side.flushSync()
}

export async function flushLog(): Promise<void> {
  await Promise.all([file?.flush(), ...[...sideFiles.values()].map((side) => side.flush())])
}

function prune(): void {
  if (!prunes || !dir || pruning) return
  const folder = dir
  pruning = pruneLogFolder(folder, {
    now: Date.now(),
    maxAgeMs: LOG_LIMITS.maxAgeMs,
    verbosePrefix: VERBOSE_PREFIX,
    verboseAgeMs: LOG_LIMITS.verboseAgeMs,
    maxFolderBytes: LOG_LIMITS.folderBytes,
  }).finally(() => {
    pruning = null
  })
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Routes console output into the log, so what libraries print lands in the file too; with echo
 * on it is still printed.
 */
export function captureConsole(): void {
  const to =
    (recordLevel: LogLevel) =>
    (...args: unknown[]): void =>
      writeLog(recordLevel, 'console', args.map(describe).join(' '))
  console.log = to('info')
  console.info = to('info')
  console.warn = to('warn')
  console.error = to('error')
  console.debug = to('debug')
}

/**
 * Logs uncaught exceptions without changing how the process handles them. With `rejections` it
 * also logs unhandled rejections, which a listener keeps from ending the process; only for a
 * process that already outlives them.
 */
export function logProcessFailures({ rejections }: { rejections: boolean }): void {
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    writeLog('error', 'process', `${origin}: ${describe(error)}`)
    flushLogSync()
  })
  if (!rejections) return
  process.on('unhandledRejection', (reason) => {
    writeLog('error', 'process', `Unhandled rejection: ${describe(reason)}`)
  })
}

/** A forked host's log, from its first line: the file its parent named, its console and failures. */
export function startHostLog(name: string): void {
  openProcessLogFromEnv(name)
  captureConsole()
  logProcessFailures({ rejections: false })
}
