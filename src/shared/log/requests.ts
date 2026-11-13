// A client's request as an action record: its method and its parameters reduced to ids, choices,
// numbers and switches. Text, such as a prompt, a path or a search, appears only as its length.

import { writeLog } from './process-log'

// Keys whose short string values are ids or choices, never what the user wrote.
const CHOICE_KEYS = new Set([
  'agentId',
  'decision',
  'direction',
  'format',
  'harnessId',
  'kind',
  'level',
  'method',
  'mode',
  'optionId',
  'reason',
  'scope',
  'sort',
  'state',
  'status',
  'type',
])
const ID_KEY = /(?:^id|Id)$/
const IDS_KEY = /Ids$/
const SECRET_KEY = /key|token|secret|passw|credential/i
const MAX_ID_CHARS = 128
const MAX_LISTED_IDS = 20

// The last part of a method that only reads or watches; logged at debug, as windows poll them.
const READS = new Set([
  'avatarUrl',
  'blob',
  'branches',
  'changes',
  'check',
  'collect',
  'comments',
  'complete',
  'consents',
  'content',
  'context',
  'currentPullRequest',
  'details',
  'environment',
  'file',
  'fileDiff',
  'held',
  'incoming',
  'issue',
  'list',
  'listSessions',
  'options',
  'outline',
  'outlineTitles',
  'page',
  'pullRequest',
  'read',
  'readFirstOptions',
  'readOptions',
  'replay',
  'runs',
  'search',
  'snapshot',
  'status',
  'summary',
  'taskOutput',
  'tools',
  'total',
  'unwatch',
  'versions',
  'waiting',
  'watch',
  'resize',
  'attach',
])

// Keystrokes and flow control: too many to log, and a terminal's input is never logged.
const UNLOGGED = new Set(['terminals.input', 'terminals.ack'])

export function isReadMethod(method: string): boolean {
  const action = method.slice(method.lastIndexOf('.') + 1)
  return READS.has(action)
}

function summarizeValue(key: string, value: unknown): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (SECRET_KEY.test(key) && !ID_KEY.test(key)) return '<omitted>'
  if (typeof value === 'string') {
    if ((ID_KEY.test(key) || CHOICE_KEYS.has(key)) && value.length <= MAX_ID_CHARS) return value
    return `<${value.length} chars>`
  }
  if (Array.isArray(value)) {
    if (IDS_KEY.test(key) && value.every((item) => typeof item === 'string')) {
      const ids = value.slice(0, MAX_LISTED_IDS) as string[]
      return value.length > ids.length ? [...ids, `<${value.length - ids.length} more>`] : ids
    }
    return `<${value.length} items>`
  }
  if (typeof value === 'object') return '<object>'
  return `<${typeof value}>`
}

export function summarizeParams(params: unknown): Record<string, unknown> | undefined {
  if (params === undefined || params === null) return undefined
  if (typeof params !== 'object' || Array.isArray(params)) {
    return { params: summarizeValue('params', params) }
  }
  const summary: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) summary[key] = summarizeValue(key, value)
  return summary
}

/** How long a client's repeats of its last request are counted before the count is written. */
export const REQUEST_REPEAT_MS = 10_000

interface Last {
  key: string
  method: string
  data: Record<string, unknown>
  /** Repeats since the request or the count was last written. */
  repeats: number
  timer: ReturnType<typeof setTimeout> | null
}

/** Each client's last request, by device id or '' for the windows. */
const lasts = new Map<string, Last>()

function levelOf(method: string): 'debug' | 'info' {
  return isReadMethod(method) ? 'debug' : 'info'
}

/** The record's key, the same whatever order the params' keys came in. */
function recordKey(method: string, data: Record<string, unknown>): string {
  const sorted = Object.keys(data)
    .sort()
    .map((key) => [key, data[key]])
  return `${method}\0${JSON.stringify(sorted)}`
}

function writeRepeats(last: Last): void {
  if (last.timer) clearTimeout(last.timer)
  last.timer = null
  if (last.repeats === 0) return
  writeLog(levelOf(last.method), 'request', `${last.method} repeated ${last.repeats} times`, {
    ...last.data,
    repeated: last.repeats,
  })
  last.repeats = 0
}

/**
 * Logs a client's request where the host receives it: `info` for actions, `debug` for reads. A
 * client's repeats of its last request are counted, and the count is written once a different
 * request comes from it or `REQUEST_REPEAT_MS` after the first repeat.
 */
export function logRequest(method: string, params: unknown, device: string | null): void {
  if (UNLOGGED.has(method)) return
  const data = { ...(device ? { device } : {}), ...summarizeParams(params) }
  const client = device ?? ''
  const key = recordKey(method, data)
  const last = lasts.get(client)
  if (last?.key === key) {
    last.repeats++
    if (!last.timer) {
      last.timer = setTimeout(() => writeRepeats(last), REQUEST_REPEAT_MS)
      last.timer.unref()
    }
    return
  }
  if (last) writeRepeats(last)
  lasts.set(client, { key, method, data, repeats: 0, timer: null })
  writeLog(levelOf(method), 'request', method, data)
}
