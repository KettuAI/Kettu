// What the user does in this window, for the log: where they go and the commands they run, sent
// to main in batches. Only ids and choices; never what they typed.

import type { ActionReport } from '@shared/ipc'
import { placeOf, useViewStore } from '@renderer/stores/view'

const FLUSH_MS = 2000
const FLUSH_COUNT = 50
const MAX_VALUE_CHARS = 128

let queue: ActionReport[] = []
let timer: ReturnType<typeof setTimeout> | null = null
// The place last recorded, kept across a remount so the same place is not recorded twice.
let last = ''

function flush(): void {
  if (timer) clearTimeout(timer)
  timer = null
  if (queue.length === 0) return
  const batch = queue
  queue = []
  window.kettu.diagnostics.recordActions(batch)
}

export function recordAction(name: string, data?: ActionReport['data']): void {
  queue.push({ at: Date.now(), name, ...(data && { data }) })
  if (queue.length >= FLUSH_COUNT) flush()
  else timer ??= setTimeout(flush, FLUSH_MS)
}

/** The short id and choice fields of a place, which is all its record carries. */
function fieldsOf(place: object): ActionReport['data'] {
  const data: NonNullable<ActionReport['data']> = {}
  for (const [key, value] of Object.entries(place)) {
    if (key === 'kind') continue
    if (typeof value === 'boolean' || typeof value === 'number' || value === null) {
      data[key] = value
    } else if (typeof value === 'string' && value.length <= MAX_VALUE_CHARS) {
      data[key] = value
    }
  }
  return data
}

/** Records each change of what the window shows, from now on. */
export function watchNavigation(): () => void {
  window.addEventListener('pagehide', flush)
  const record = (): void => {
    const place = placeOf(useViewStore.getState())
    const key = JSON.stringify(place)
    if (key === last) return
    last = key
    recordAction(`view.${place.kind}`, fieldsOf(place))
  }
  record()
  const unsubscribe = useViewStore.subscribe(record)
  return () => {
    unsubscribe()
    window.removeEventListener('pagehide', flush)
    flush()
  }
}
