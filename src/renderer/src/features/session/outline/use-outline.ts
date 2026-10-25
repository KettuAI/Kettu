import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OutlineEntry } from '@shared/agent-host'
import { firstLine, outlineText } from '@shared/outline'
import { errorMessage, host } from '@renderer/lib/host'
import { useSettingsStore } from '@renderer/stores/settings'
import { useThreadsStore } from '@renderer/stores/threads'

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
 * those the replica holds that it does not list yet, such as one just sent.
 */
export function useOutline(sessionId: string): {
  rows: OutlineRow[]
  /** For the list opening: lists again, and asks for the missing titles if the setting allows. */
  opened: () => void
} {
  const order = useThreadsStore((s) => s.replicas[sessionId]?.state?.order)
  // A user message stays one, so the kinds are read when the order changes, not on every patch.
  const userIds = useMemo(() => {
    const byId = useThreadsStore.getState().replicas[sessionId]?.state?.byId
    return (order ?? []).filter((id) => byId?.[id]?.kind === 'user')
  }, [sessionId, order])
  const [listed, setListed] = useState<OutlineEntry[] | null>(null)
  const latest = useRef(0)

  const refresh = useCallback(() => {
    const request = ++latest.current
    host('sessions.outline', { sessionId })
      .then(({ entries }) => {
        if (request === latest.current) setListed(entries)
      })
      .catch((error: unknown) => {
        console.warn(`Could not list the outline of ${sessionId}: ${errorMessage(error)}`)
      })
  }, [sessionId])

  const known = useMemo(() => new Set(listed?.map((entry) => entry.entryId)), [listed])
  const unlisted = listed === null || userIds.some((id) => !known.has(id))
  useEffect(() => {
    if (unlisted) refresh()
  }, [unlisted, userIds, refresh])

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
      if (known.has(id) || entry?.kind !== 'user') continue
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
    host('sessions.outlineTitles', { sessionId })
      .then(({ titles }) => {
        if (titles.length === 0) return
        const byPos = new Map(titles.map(({ pos, title }) => [pos, title]))
        setListed(
          (current) =>
            current?.map((entry) => {
              const title = byPos.get(entry.pos)
              return title === undefined ? entry : { ...entry, title }
            }) ?? current,
        )
      })
      .catch((error: unknown) => {
        console.warn(`Could not title the outline of ${sessionId}: ${errorMessage(error)}`)
      })
  }, [sessionId, rows, refresh])

  return { rows, opened }
}
