// What a window did, as the renderer reports it for the log: untrusted input, so only short names
// and a few short values pass, and nothing that could carry what the user typed at length.

export interface ActionRecord {
  at: number
  name: string
  data: Record<string, string | number | boolean | null>
}

export const MAX_ACTIONS_PER_BATCH = 100
const MAX_FIELDS = 8
const MAX_VALUE_CHARS = 128
const NAME = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+){0,3}$/i
const MAX_NAME_CHARS = 64
const KEY = /^[a-z][a-z0-9]{0,31}$/i
// A record more than this far from main's clock is from a page that held it too long.
const MAX_SKEW_MS = 10 * 60 * 1000

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseData(value: unknown): ActionRecord['data'] | null {
  if (value === undefined) return {}
  if (!isRecordObject(value)) return null
  const entries = Object.entries(value)
  if (entries.length > MAX_FIELDS) return null
  const data: ActionRecord['data'] = {}
  for (const [key, field] of entries) {
    if (!KEY.test(key)) return null
    if (typeof field === 'string') {
      if (field.length > MAX_VALUE_CHARS) return null
      data[key] = field
    } else if (typeof field === 'number') {
      if (!Number.isFinite(field)) return null
      data[key] = field
    } else if (typeof field === 'boolean' || field === null) {
      data[key] = field
    } else {
      return null
    }
  }
  return data
}

/** The valid records of a batch, and how many were not; a batch that is no list has none. */
export function parseActionBatch(
  value: unknown,
  now: number,
): { records: ActionRecord[]; rejected: number } {
  if (!Array.isArray(value)) return { records: [], rejected: 1 }
  const records: ActionRecord[] = []
  let rejected = Math.max(0, value.length - MAX_ACTIONS_PER_BATCH)
  for (const item of value.slice(0, MAX_ACTIONS_PER_BATCH)) {
    if (!isRecordObject(item)) {
      rejected++
      continue
    }
    const { at, name } = item
    const data = parseData(item['data'])
    if (
      typeof at !== 'number' ||
      !Number.isFinite(at) ||
      Math.abs(now - at) > MAX_SKEW_MS ||
      typeof name !== 'string' ||
      name.length > MAX_NAME_CHARS ||
      !NAME.test(name) ||
      data === null
    ) {
      rejected++
      continue
    }
    records.push({ at, name, data })
  }
  return { records, rejected }
}
