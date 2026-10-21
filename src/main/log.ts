export type LogLevel = 'info' | 'warn' | 'error'

export interface LogRecord {
  at: number
  level: LogLevel
  source: string
  message: string
}

const MAX_RECORDS = 500
const records: LogRecord[] = []

function write(level: LogLevel, source: string, message: string): void {
  const record = { at: Date.now(), level, source, message }
  records.push(record)
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS)
  const line = `[${new Date(record.at).toISOString()}] [${source}] ${message}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string, error?: unknown): void
}

/** A logger for one part of main; the last 500 records are kept for diagnostics. */
export function createLogger(source: string): Logger {
  return {
    info: (message) => write('info', source, message),
    warn: (message) => write('warn', source, message),
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
