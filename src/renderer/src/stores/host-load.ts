// Each host's load as the window shows it. A view that shows the numbers watches its host: the
// list of computers, a computer's page and New session's host menu while it is open. The host
// sends `host.load` every 2 s while the lease is renewed and stops when the last view goes. The
// CPU line is drawn from the readings since the watch started, kept only here and dropped with it.

import { useEffect } from 'react'
import { create } from 'zustand'
import { LOAD_LEASE_MS, type HostLoad, type HostLoadWatch } from '@shared/host-load'
import { errorCode, errorMessage, hostAt } from '@renderer/lib/host'

/** A host's key in the store: its id, or '' for this computer. */
const keyOf = (hostId: string | null): string => hostId ?? ''

/** A watch is renewed this long before its lease would run out. */
const RENEW_MS = LOAD_LEASE_MS - 10_000
/** How far back the CPU's line goes. */
export const SPARK_MS = 10 * 60_000

export interface LiveLoad {
  load: HostLoad
  /** The CPU of each reading since the watch started, within SPARK_MS. */
  recent: { at: number; cpu: number }[]
}

interface HostLoadStore {
  live: Record<string, LiveLoad>
  /** Hosts older than the load, which cannot report it. */
  unsupported: Record<string, true>
}

export const useHostLoadStore = create<HostLoadStore>()(() => ({
  live: {},
  unsupported: {},
}))

interface Watch {
  hostId: string | null
  /** Views watching. */
  count: number
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
    return
  }
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`Could not read a host's load: ${errorMessage(error)}`)
}

function ask(key: string): void {
  const watch = watches.get(key)
  if (!watch) return
  hostAt(watch.hostId, 'host.load.watch', undefined).then(
    (answer: HostLoadWatch) => {
      warned.delete(key)
      setKey('unsupported', key, undefined)
      if (watches.get(key) === watch) receive(key, answer.load)
    },
    (error: unknown) => failed(key, error),
  )
}

function receive(key: string, load: HostLoad): void {
  const recent = useHostLoadStore.getState().live[key]?.recent ?? []
  const last = recent.at(-1)
  const next =
    last && last.at >= load.at ? recent : [...recent, { at: load.at, cpu: load.cpu.percent }]
  setKey('live', key, {
    load,
    recent: next.filter((point) => point.at > load.at - SPARK_MS),
  })
}

/** Watches a host's load until the returned function is called; views of one host share it. */
export function watchLoad(hostId: string | null): () => void {
  const key = keyOf(hostId)
  let watch = watches.get(key)
  if (!watch) {
    watch = { hostId, count: 0, timer: setInterval(() => ask(key), RENEW_MS) }
    watches.set(key, watch)
  }
  watch.count++
  if (watch.count === 1) ask(key)
  let released = false
  return () => {
    if (released) return
    released = true
    const current = watches.get(key)
    if (current !== watch || --current.count > 0) return
    clearInterval(current.timer)
    watches.delete(key)
    setKey('live', key, undefined)
    void hostAt(hostId, 'host.load.unwatch', undefined).catch(() => {})
  }
}

/** Watches a host's load while the calling view shows it. */
export function useLoadWatch(hostId: string | null, enabled = true): void {
  useEffect(() => {
    if (!enabled) return
    return watchLoad(hostId)
  }, [hostId, enabled])
}

export const useLiveLoad = (hostId: string | null): LiveLoad | null =>
  useHostLoadStore((s) => s.live[keyOf(hostId)] ?? null)

export const useLoadUnsupported = (hostId: string | null): boolean =>
  useHostLoadStore((s) => s.unsupported[keyOf(hostId)] === true)

/** One of a host's `host.load` events, heard while it is watched. */
export function receiveLoad(hostId: string | null, load: HostLoad): void {
  const key = keyOf(hostId)
  if (watches.has(key) && useHostLoadStore.getState().live[key]) receive(key, load)
}

/** A new connection to the host, or this computer's host started again: a watch is asked again. */
export function hostLoadOpened(hostId: string | null): void {
  if (watches.has(keyOf(hostId))) ask(keyOf(hostId))
}

/** The connection to the host ended: what it said no longer holds, and it may come back newer. */
export function hostLoadClosed(hostId: string): void {
  setKey('live', hostId, undefined)
  setKey('unsupported', hostId, undefined)
}
