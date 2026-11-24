import { useEffect } from 'react'
import { create } from 'zustand'
import type { PluginRefSource } from '@shared/plugin-refs'
import { hostAt } from '@renderer/lib/host'

interface PluginRefsStore {
  /** What each host's plugins declare for `@` and links, by host id, '' for this computer. */
  byHost: Record<string, readonly PluginRefSource[]>
}

export const usePluginRefsStore = create<PluginRefsStore>()(() => ({ byHost: {} }))

const NONE: readonly PluginRefSource[] = []
const keyOf = (hostId: string | null): string => hostId ?? ''

const reading = new Map<string, Promise<void>>()

/**
 * Reads what a host's plugins declare again. A host that does not know the request, as an older
 * one does not, has none; a read that finds the same ones changes nothing.
 */
export function loadPluginRefs(hostId: string | null): Promise<void> {
  const key = keyOf(hostId)
  const running = reading.get(key)
  if (running) return running
  const read = hostAt(hostId, 'plugins.refs', undefined)
    .then(
      ({ plugins }) => plugins,
      () => NONE,
    )
    .then((plugins) => {
      const before = usePluginRefsStore.getState().byHost[key]
      if (before !== undefined && JSON.stringify(before) === JSON.stringify(plugins)) return
      usePluginRefsStore.setState((s) => ({ byHost: { ...s.byHost, [key]: plugins } }))
    })
    .finally(() => reading.delete(key))
  reading.set(key, read)
  return read
}

/** The plugins of a host that declare something, read once the first time anything asks. */
export function usePluginRefs(hostId: string | null): readonly PluginRefSource[] {
  const key = keyOf(hostId)
  const known = usePluginRefsStore((s) => s.byHost[key])
  useEffect(() => {
    if (known === undefined) void loadPluginRefs(hostId)
  }, [known, hostId])
  return known ?? NONE
}
