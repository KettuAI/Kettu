// What an update to an artifact changed, worked out by comparing two of its versions' files: a
// canvas's frames, a document's sections, a deck's slides, or else the files themselves.

import { useEffect, useState } from 'react'
import type { ArtifactChanges } from '@shared/artifact-changes'
import type { ArtifactContent } from '@shared/artifacts'
import { host } from '@renderer/lib/host'

export type { ChangedFrame } from '@shared/artifact-changes'
export type Changes = ArtifactChanges

/** About as many cards as a long thread scrolls past; older ones are worked out again. */
const KEPT = 200

// A version never changes once written, so each pair is worked out once.
const reads = new Map<string, { changes: Changes | null | undefined; done: Promise<void> }>()

function readOf(id: string, from: number, to: number) {
  const key = `${id}:${from}:${to}`
  let read = reads.get(key)
  if (!read) {
    const next = { changes: undefined as Changes | null | undefined, done: Promise.resolve() }
    next.done = changesBetween(id, from, to).then(
      (changes) => void (next.changes = changes),
      (error: unknown) => {
        console.warn(`Could not compare versions ${from} and ${to} of ${id}`, error)
        next.changes = null
      },
    )
    reads.set(key, next)
    if (reads.size > KEPT) reads.delete(reads.keys().next().value!)
    read = next
  }
  return read
}

/** What changed from `from` to `to`, read once and shared with the cards that say it. */
export async function changesOf(id: string, from: number, to: number): Promise<Changes | null> {
  const read = readOf(id, from, to)
  await read.done
  return read.changes ?? null
}

/**
 * What changed from version `from` to `to`, once `enabled`: undefined while it is worked out, null
 * when it cannot be, as for an older host whose files carry no hash, or when nothing changed.
 */
export function useChanges(
  id: string,
  from: number | null,
  to: number | null,
  enabled: boolean,
): Changes | null | undefined {
  const key = from !== null && to !== null && from !== to ? `${id}:${from}:${to}` : null
  const [, setDone] = useState(0)
  useEffect(() => {
    if (!enabled || key === null) return
    const read = readOf(id, from!, to!)
    let live = true
    void read.done.then(() => live && setDone((n) => n + 1))
    return () => {
      live = false
    }
  }, [id, from, to, key, enabled])
  return key === null ? null : reads.get(key)?.changes
}

async function changesBetween(id: string, from: number, to: number): Promise<Changes | null> {
  // One request to a host that compares them itself; an older host's versions are read here.
  const asked = await host('artifacts.changes', { id, from, to }).catch(() => null)
  if (asked) return asked.changes
  const [before, after] = await Promise.all([
    host('artifacts.read', { id, version: from }),
    host('artifacts.read', { id, version: to }),
  ])
  if (before.version !== from || after.version !== to) return null
  const { compareVersions } = await import('@shared/artifact-changes')
  const version = (content: ArtifactContent) => ({
    version: content.version,
    files: content.files,
    type: content.type?.name ?? null,
  })
  return compareVersions(version(before), version(after), async (version, path) => {
    const { bytes } = await host('artifacts.file', { id, version, path })
    return new TextDecoder().decode(bytes)
  })
}
