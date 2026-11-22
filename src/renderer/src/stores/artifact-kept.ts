import { create } from 'zustand'
import { readJson, writeJson } from '@renderer/lib/storage'

/** The artifacts whose choice is kept; the least recently chosen goes first. */
const KEPT = 200

/**
 * A choice made per artifact and kept on this device in localStorage, such as the width a web
 * page is laid out at: each artifact's value, the default for one never chosen, which is not
 * stored, and a setter. Values read back that `valid` refuses are dropped.
 */
export function keptPerArtifact<T>(
  key: string,
  fallback: T,
  valid: (value: unknown) => value is T,
): { use: (id: string) => T; set: (id: string, value: T) => void } {
  const load = (): Record<string, T> => {
    const stored = readJson<unknown>(key, null)
    if (!stored || typeof stored !== 'object') return {}
    const out: Record<string, T> = {}
    for (const [id, value] of Object.entries(stored)) if (valid(value)) out[id] = value
    return out
  }
  const store = create<{ byId: Record<string, T> }>(() => ({ byId: load() }))
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  store.subscribe(({ byId }) => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => writeJson(key, byId), 300)
  })
  return {
    use: (id) => store((s) => (Object.hasOwn(s.byId, id) ? s.byId[id]! : fallback)),
    set: (id, value) =>
      store.setState((s) => {
        if ((Object.hasOwn(s.byId, id) ? s.byId[id] : fallback) === value) return s
        // Chosen again, it moves to the end, the most recent.
        const next: Record<string, T> = { ...s.byId }
        delete next[id]
        if (value !== fallback) next[id] = value
        const ids = Object.keys(next)
        for (const old of ids.slice(0, Math.max(0, ids.length - KEPT))) delete next[old]
        return { byId: next }
      }),
  }
}
