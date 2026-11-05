import { writeLog } from '@shared/log/process-log'

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogRecord {
  at: number
  level: LogLevel
  source: string
  message: string
}

const MAX_RECORDS = 500
const records: LogRecord[] = []

function write(level: LogLevel, source: string, message: string, data?: LogData): void {
  records.push({ at: Date.now(), level, source, message })
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS)
  writeLog(level, source, message, data)
}

export type LogData = Record<string, unknown>

export interface Logger {
  debug(message: string, data?: LogData): void
  info(message: string, data?: LogData): void
  warn(message: string, data?: LogData): void
  error(message: string, error?: unknown): void
}

/**
 * A logger for one part of main or the daemon: each record goes to the process's log file, and
 * the last 500 above debug stay in memory for diagnostics.
 */
export function createLogger(source: string): Logger {
  return {
    debug: (message, data) => writeLog('debug', source, message, data),
    info: (message, data) => write('info', source, message, data),
    warn: (message, data) => write('warn', source, message, data),
    error: (message, error) =>
      write('error', source, error === undefined ? message : `${message}: ${describeError(error)}`),
  }
}

export function recentLogRecords(): LogRecord[] {
  return records.slice()
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`
  return String(error)
}
