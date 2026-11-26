import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { firstLine, outlineText } from '@shared/outline'
import { errorMessage, host } from '@renderer/lib/host'
import { useSettingsStore } from '@renderer/stores/settings'
import { useThreadsStore } from '@renderer/stores/threads'
import {
  beginOutlineFetch,
  commitCachedOutline,
  getCachedOutline,
  outlineCacheEpoch,
  patchCachedOutlineTitles,
  subscribeOutline,
  touchCachedOutline,
} from './outline-cache'

/** A row of the outline; `pos` is null for a message the host has not listed yet. */
export interface OutlineRow {
  entryId: string
  pos: number | null
  /** The title, or the first line until it has one. */
  label: string
  titled: boolean
}

/**
 * The session's user messages: the host's list, which reaches pages not loaded yet, joined with
 * those the replica holds that it does not list yet, such as one just sent. Cached across session
 * switches so clicking back and forth does not re-query SQLite unless entries changed or the list
 * is explicitly opened.
 */
export function useOutline(sessionId: string): {
  rows: OutlineRow[]
  /** For the list opening: lists again, and asks for the missing titles if the setting allows. */
  opened: () => void
} {
  const order = useThreadsStore((s) => s.replicas[sessionId]?.state?.order)
  const older = useThreadsStore((s) => s.replicas[sessionId]?.older ?? null)
  const hasState = order !== undefined
  // A user message stays one, so the kinds are read when the order changes, not on every patch.
  const userIds = useMemo(() => {
    const byId = useThreadsStore.getState().replicas[sessionId]?.state?.byId
    return (order ?? []).filter((id) => {
      const entry = byId?.[id]
      return entry?.kind === 'user' && !entry.from && !entry.approval && !entry.kettu
    })
  }, [sessionId, order])
  const userIdSet = useMemo(() => new Set(userIds), [userIds])

  const subscribe = useCallback(
    (listener: () => void) => subscribeOutline(sessionId, listener),
    [sessionId],
  )
  const getSnapshot = useCallback(() => getCachedOutline(sessionId), [sessionId])
  const listed = useSyncExternalStore(subscribe, getSnapshot)

  useEffect(() => {
    touchCachedOutline(sessionId)
  }, [sessionId])

  const refresh = useCallback(() => {
    const ticket = beginOutlineFetch(sessionId)
    host('sessions.outline', { sessionId })
      .then(({ entries }) => {
        commitCachedOutline(sessionId, entries, ticket)
      })
      .catch((error: unknown) => {
        console.warn(`Could not list the outline of ${sessionId}: ${errorMessage(error)}`)
      })
  }, [sessionId])

  const known = useMemo(() => new Set(listed?.map((entry) => entry.entryId)), [listed])
  const hasUnlisted = listed === null || userIds.some((id) => !known.has(id))
  const hasRemoved =
    hasState &&
    listed !== null &&
    listed.some((entry) => (older === null || entry.pos >= older) && !userIdSet.has(entry.entryId))
  const needsRefresh = hasUnlisted || hasRemoved
  useEffect(() => {
    if (needsRefresh) refresh()
  }, [needsRefresh, userIds, refresh])

  const rows = useMemo(() => {
    const out: OutlineRow[] = (listed ?? []).map((entry) => ({
      entryId: entry.entryId,
      pos: entry.pos,
      label: entry.title ?? entry.text,
      titled: entry.title !== null,
    }))
    const byId = useThreadsStore.getState().replicas[sessionId]?.state?.byId
    for (const id of userIds) {
      const entry = byId?.[id]
      if (known.has(id) || entry?.kind !== 'user' || entry.from || entry.approval || entry.kettu) {
        continue
      }
      out.push({
        entryId: id,
        pos: null,
        label: firstLine(outlineText(entry.content)),
        titled: false,
      })
    }
    return out
  }, [sessionId, listed, known, userIds])

  const opened = useCallback(() => {
    refresh()
    if (!useSettingsStore.getState().settings.thread.outlineSummaries) return
    if (rows.every((row) => row.titled || row.label === '')) return
    const epoch = outlineCacheEpoch(sessionId)
    host('sessions.outlineTitles', { sessionId })
      .then(({ titles }) => {
        patchCachedOutlineTitles(sessionId, titles, epoch)
      })
      .catch((error: unknown) => {
        console.warn(`Could not title the outline of ${sessionId}: ${errorMessage(error)}`)
      })
  }, [sessionId, rows, refresh])

  return { rows, opened }
}
