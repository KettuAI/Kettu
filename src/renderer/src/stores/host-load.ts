// Each host's load as the window shows it. A view that shows the numbers watches its host, the
// list of hosts without what uses them and a host's page with it; the host sends `host.load` every
// 2 s while the lease is renewed, and stops when the last view goes. Whether a host runs low comes
// with its status, read when its connection opens and pushed as it changes, so the sidebar and New
// session's host menu show it without a watch.

import { useEffect } from 'react'
import { create } from 'zustand'
import {
  LOAD_HISTORY_POINTS,
  LOAD_LEASE_MS,
  type HostLoad,
  type HostLoadPoint,
  type HostLoadUsage,
  type HostLoadWatch,
  type HostStrain,
} from '@shared/host-load'
import { errorCode, errorMessage, hostAt } from '@renderer/lib/host'

/** A host's key in the store: its id, or '' for this computer. */
const keyOf = (hostId: string | null): string => hostId ?? ''

/** A watch is renewed this long before its lease would run out. */
const RENEW_MS = LOAD_LEASE_MS - 10_000
/** How far back the CPU's line goes. */
export const SPARK_MS = 10 * 60_000

export interface LiveLoad {
  load: HostLoad
  /** One point a minute for the last hour. */
  history: HostLoadPoint[]
  /** The CPU of each reading since the watch started, within SPARK_MS. */
  recent: { at: number; cpu: number }[]
  /** What uses the computer, once a watch with it has been answered. */
  usage: HostLoadUsage | null
}

interface HostLoadStore {
  live: Record<string, LiveLoad>
  /** Hosts older than the load, which cannot report it. */
  unsupported: Record<string, true>
  strains: Record<string, HostStrain[]>
}

export const useHostLoadStore = create<HostLoadStore>()(() => ({
  live: {},
  unsupported: {},
  strains: {},
}))

interface Watch {
  hostId: string | null
  /** Views watching, and those of them that show what uses the computer. */
  count: number
  detail: number
  timer: ReturnType<typeof setInterval>
}

const watches = new Map<string, Watch>()
const warned = new Set<string>()

function setKey<K extends keyof HostLoadStore>(
  field: K,
  key: string,
  value: HostLoadStore[K][string] | undefined,
): void {
  useHostLoadStore.setState((state) => {
    const next = { ...state[field] } as Record<string, unknown>
    if (value === undefined) delete next[key]
    else next[key] = value
    return { [field]: next } as Partial<HostLoadStore>
  })
}

/** A failed request: an old host is marked as one, anything else is said once in the console. */
function failed(key: string, error: unknown): void {
  if (errorCode(error) === 'unknown_method') {
    setKey('unsupported', key, true)
    setKey('strains', key, undefined)
    return
  }
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`Could not read a host's load: ${errorMessage(error)}`)
}

function ask(key: string): void {
  const watch = watches.get(key)
  if (!watch) return
  const detail = watch.detail > 0
  hostAt(watch.hostId, 'host.load.watch', { detail }).then(
    (answer) => {
      warned.delete(key)
      if (watches.get(key) === watch) took(key, answer, detail)
    },
    (error: unknown) => failed(key, error),
  )
}

function took(key: string, answer: HostLoadWatch, detail: boolean): void {
  const before = useHostLoadStore.getState().live[key]
  setKey('unsupported', key, undefined)
  setKey('live', key, {
    load: answer.load,
    history: answer.history,
    recent: withReading(before?.recent ?? [], answer.load),
    usage: detail ? (answer.usage ?? before?.usage ?? null) : null,
  })
}

function withReading(recent: LiveLoad['recent'], load: HostLoad): LiveLoad['recent'] {
  const last = recent.at(-1)
  const kept =
    last && last.at >= load.at ? recent : [...recent, { at: load.at, cpu: load.cpu.percent }]
  return kept.filter((point) => point.at > load.at - SPARK_MS)
}

/**
 * Watches a host's load until the returned function is called; `detail` adds what uses it. Views
 * that watch one host share its watch, which asks for the detail while any of them shows it.
 */
export function watchLoad(hostId: string | null, detail: boolean): () => void {
  const key = keyOf(hostId)
  let watch = watches.get(key)
  const hadDetail = (watch?.detail ?? 0) > 0
  if (!watch) {
    watch = { hostId, count: 0, detail: 0, timer: setInterval(() => ask(key), RENEW_MS) }
    watches.set(key, watch)
  }
  watch.count++
  if (detail) watch.detail++
  if (watch.count === 1 || (detail && !hadDetail)) ask(key)
  let released = false
  return () => {
    if (released) return
    released = true
    const current = watches.get(key)
    if (current !== watch) return
    current.count--
    if (detail) current.detail--
    if (current.count === 0) {
      clearInterval(current.timer)
      watches.delete(key)
      setKey('live', key, undefined)
      void hostAt(hostId, 'host.load.unwatch', undefined).catch(() => {})
    } else if (detail && current.detail === 0) {
      ask(key)
    }
  }
}

/** Watches a host's load while the calling view shows it. */
export function useLoadWatch(hostId: string | null, detail: boolean, enabled = true): void {
  useEffect(() => {
    if (!enabled) return
    return watchLoad(hostId, detail)
  }, [hostId, detail, enabled])
}

const NO_STRAINS: HostStrain[] = []

export const useLiveLoad = (hostId: string | null): LiveLoad | null =>
  useHostLoadStore((s) => s.live[keyOf(hostId)] ?? null)

export const useLoadUnsupported = (hostId: string | null): boolean =>
  useHostLoadStore((s) => s.unsupported[keyOf(hostId)] === true)

export const useStrains = (hostId: string | null): HostStrain[] =>
  useHostLoadStore((s) => s.strains[keyOf(hostId)] ?? NO_STRAINS)

/** One of a host's `host.load` events, heard while it is watched. */
export function receiveLoad(
  hostId: string | null,
  load: HostLoad,
  point: HostLoadPoint,
  usage: HostLoadUsage | undefined,
): void {
  const key = keyOf(hostId)
  const watch = watches.get(key)
  const live = useHostLoadStore.getState().live[key]
  if (!watch || !live) return
  const history = live.history.at(-1)?.at === point.at ? live.history.slice(0, -1) : live.history
  setKey('live', key, {
    load,
    history: [...history, point].slice(-LOAD_HISTORY_POINTS),
    recent: withReading(live.recent, load),
    usage: watch.detail > 0 ? (usage ?? live.usage) : null,
  })
}

export function receiveStrains(hostId: string | null, strains: HostStrain[]): void {
  setKey('strains', keyOf(hostId), strains)
}

/**
 * A new connection to the host, or this computer's host started again: whether it runs low is
 * read, and a watch it lost with the old connection is asked for again.
 */
export function hostLoadOpened(hostId: string | null): void {
  const key = keyOf(hostId)
  hostAt(hostId, 'host.status', undefined).then(
    (status) => {
      setKey('unsupported', key, undefined)
      receiveStrains(hostId, status.strains)
    },
    (error: unknown) => failed(key, error),
  )
  if (watches.has(key)) ask(key)
}

/** The connection to the host ended: what it said no longer holds. */
export function hostLoadClosed(hostId: string): void {
  setKey('strains', hostId, undefined)
  setKey('live', hostId, undefined)
}
