import { memo, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { VersionSummary } from '@shared/artifacts'
import type { ArtifactEntry as Entry } from '@shared/thread'
import { ArtifactCard } from '@renderer/features/artifacts/artifact-card'
import { artifactKind } from '@renderer/features/artifacts/model'
import { useInView } from '@renderer/features/artifacts/use-in-view'
import { host, learnArtifactHost, sessionHost } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import {
  artifactListShown,
  artifactStanding,
  useArtifactsStore,
  type ArtifactStanding,
} from '@renderer/stores/artifacts'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { useThreadsStore } from '@renderer/stores/threads'
import { openArtifact, toggleArtifactPane, useViewStore } from '@renderer/stores/view'
import { useEntry, useEntryAnimation } from '../use-thread'
import { artifactCardSize, isLastArtifactEntry, type ArtifactCardSize } from './artifact-size'

/**
 * A write to the artifacts service, as the artifact's card: in full for a turn's main output, the
 * panel half as tall otherwise, and smallest for a deletion. A click opens it beside the thread.
 */
export const ArtifactEntry = memo(function ArtifactEntry({
  sessionId,
  entryId,
}: {
  sessionId: string
  entryId: string
}) {
  const entry = useEntry(sessionId, entryId, 'artifact')
  // A session's artifacts are kept where it runs, which every request for one goes by.
  if (entry) learnArtifactHost(entry.artifactId, sessionHost(sessionId))
  const animation = useEntryAnimation(sessionId, entryId)
  const size = useThreadsStore((s) => {
    const state = s.replicas[sessionId]?.state
    return state ? artifactCardSize(state, entryId) : 'compact'
  })
  const last = useThreadsStore((s) => {
    const state = s.replicas[sessionId]?.state
    return state ? isLastArtifactEntry(state, entryId) : false
  })
  if (!entry) return null
  return (
    <EntryCard entry={entry} sessionId={sessionId} size={size} last={last} className={animation} />
  )
})

/** Where the artifact stands now: the card dims once it is deleted. */
function useStanding(id: string): ArtifactStanding {
  useEffect(() => {
    artifactListShown(true)
    return () => artifactListShown(false)
  }, [])
  return useArtifactsStore((s) => artifactStanding(s, id))
}

/** Each artifact's latest read of its versions, at the head it was read for, shared by its cards. */
const versionReads = new Map<
  string,
  { head: number | null; versions: VersionSummary[] | null; done: Promise<void> }
>()

/**
 * The artifact's versions, read once a card is in view that lacks its own. A version never changes
 * once written, so a card that has its own asks nothing more, and the artifact's cards share each
 * read.
 */
function useVersions(
  id: string,
  version: number | null,
  head: number | null,
  inView: boolean,
): VersionSummary[] | null {
  const [, setDone] = useState(0)
  const versions = versionReads.get(id)?.versions ?? null
  const missing = version !== null && !versions?.some((v) => v.version === version)
  useEffect(() => {
    if (!inView || !missing) return
    let read = versionReads.get(id)
    if (!read || read.head !== head) {
      const next = { head, versions: null as VersionSummary[] | null, done: Promise.resolve() }
      // A failed read leaves the card without its time, note and earlier version until the head
      // moves.
      next.done = host('artifacts.versions', { id }).then(
        (versions) => void (next.versions = versions),
        () => undefined,
      )
      versionReads.set(id, next)
      read = next
    }
    let live = true
    void read.done.then(() => live && setDone((n) => n + 1))
    return () => {
      live = false
    }
  }, [id, head, inView, missing])
  return versions
}

/**
 * The version before the turn's first write: past the session's own writes of the turn, skipping
 * any other's between them. Until the versions are read, as if each write made the next version.
 */
function versionBefore(
  entry: Entry,
  sessionId: string,
  versions: VersionSummary[] | null,
): number | null {
  if (entry.version === null) return null
  if (!versions) return entry.version - entry.writes >= 1 ? entry.version - entry.writes : null
  let left = entry.writes
  for (const v of versions
    .filter((v) => v.version <= entry.version!)
    .sort((a, b) => b.version - a.version)) {
    if (left === 0) return v.version
    if (v.author === sessionId) left--
  }
  return null
}

const DONE = {
  create: 'artifactEntry.created',
  update: 'artifactEntry.updated',
  restore: 'artifactEntry.restored',
} as const

function EntryCard({
  entry,
  sessionId,
  size,
  last,
  className,
}: {
  entry: Entry
  sessionId: string
  size: ArtifactCardSize
  last: boolean
  className: string | undefined
}) {
  const { t } = useTranslation(['session', 'artifacts'])
  const card = useRef<HTMLDivElement>(null)
  const standing = useStanding(entry.artifactId)
  const summary = useArtifactsStore(
    (s) =>
      s.list?.find((a) => a.id === entry.artifactId) ??
      s.deleted?.find((a) => a.id === entry.artifactId) ??
      null,
  )
  const pressed = useViewStore(
    (s) => s.sidePane[sessionId] === 'artifact' && s.sideArtifact[sessionId] === entry.artifactId,
  )
  const agent = useSessionsStore((s) => s.byId[sessionId]?.agentId ?? null)
  const agentHost = useSessionsStore((s) => {
    const session = s.byId[sessionId]
    return session ? hostOfSession(session) : null
  })
  const inView = useInView(card)
  const versions = useVersions(
    entry.artifactId,
    entry.version,
    summary?.version ?? null,
    inView && entry.action !== 'delete',
  )
  const version = versions?.find((v) => v.version === entry.version) ?? null

  const deletion = entry.action === 'delete'
  const update = entry.action !== 'create' && !deletion
  const kind = summary ? artifactKind(summary) : null
  let what = ''
  if (entry.action !== 'delete' && entry.version !== null) {
    const from = update ? versionBefore(entry, sessionId, versions) : null
    what = [
      !update && kind && t(`artifacts:page.kinds.${kind}`),
      t(DONE[entry.action]),
      from === null
        ? t('artifactEntry.version', { version: entry.version })
        : t('artifactEntry.versions', { from, to: entry.version }),
    ]
      .filter(Boolean)
      .join(' · ')
  }

  return (
    <div ref={card} className={cn('w-full', className)}>
      <ArtifactCard
        id={entry.artifactId}
        title={entry.title}
        summary={summary}
        standing={standing}
        form={deletion ? 'small' : size === 'large' ? 'full' : 'half'}
        still={deletion ? null : entry.version}
        stacked={update}
        agent={agent}
        agentHost={agentHost}
        what={what}
        at={
          version?.createdAt ??
          (summary && summary.version === entry.version ? summary.updatedAt : null)
        }
        note={update ? version?.note : null}
        current={last}
        pressed={pressed}
        onOpen={() => toggleArtifactPane(sessionId, entry.artifactId)}
        menu={{
          onOpen: () => toggleArtifactPane(sessionId, entry.artifactId, true),
          onVersionHistory: () => openArtifact(entry.artifactId, { history: true }),
          inSession: true,
        }}
      />
    </div>
  )
}
