import { memo, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import {
  THUMBNAIL_HEIGHT,
  THUMBNAIL_WIDTH,
  type ArtifactSummary,
  type VersionSummary,
} from '@shared/artifacts'
import type { ArtifactEntry as Entry } from '@shared/thread'
import { ArtifactCard, type CardForm } from '@renderer/features/artifacts/artifact-card'
import { changesLabel } from '@renderer/features/artifacts/change-words'
import { artifactKind } from '@renderer/features/artifacts/model'
import { usePartThumbnails } from '@renderer/features/artifacts/artifact-host'
import {
  usePartThumbnail,
  useThumbnail,
  type PageBox,
} from '@renderer/features/artifacts/thumbnails'
import { useInView } from '@renderer/features/artifacts/use-in-view'
import { FileTypeIcon } from '@renderer/features/files/file-type-icon'
import { host, learnArtifactHost, sessionHost } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import {
  artifactListShown,
  artifactStanding,
  useArtifactsStore,
  type ArtifactStanding,
} from '@renderer/stores/artifacts'
import { landArtifact, useArtifactWalk } from '@renderer/stores/artifact-walk'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { useThreadsStore } from '@renderer/stores/threads'
import { artifactShown, openArtifact, openArtifactTab, useViewStore } from '@renderer/stores/view'
import { useEntry, useEntryAnimation } from '../use-thread'
import { useChanges, type Changes, type ChangedFrame } from './artifact-changes'
import { isLastArtifactEntry, restoredVersionOf } from './artifact-writes'

// A click on a card opens the preview tab, which the next card's click replaces.
const PREVIEW = { preview: true }

/**
 * A write to the artifacts service, as the artifact's card across the column: a creation with its
 * page large, an update or a restore half as tall with what changed, a deletion slimmest. A click
 * opens it beside the thread.
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
  const last = useThreadsStore((s) => {
    const state = s.replicas[sessionId]?.state
    return state ? isLastArtifactEntry(state, entryId) : false
  })
  // The version a restore brought back, from the call it follows.
  const restoredFrom = useThreadsStore((s) => {
    const call = entry?.after ? s.replicas[sessionId]?.state?.byId[entry.after] : undefined
    return entry?.action === 'restore' && call?.kind === 'tool' ? restoredVersionOf(call) : null
  })
  if (!entry) return null
  return (
    <EntryCard
      entry={entry}
      sessionId={sessionId}
      last={last}
      restoredFrom={restoredFrom}
      className={animation}
    />
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

const FORMS: Record<Entry['action'], Exclude<CardForm, 'tile'>> = {
  create: 'created',
  update: 'updated',
  restore: 'updated',
  delete: 'deleted',
}

function EntryCard({
  entry,
  sessionId,
  last,
  restoredFrom,
  className,
}: {
  entry: Entry
  sessionId: string
  last: boolean
  restoredFrom: number | null
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
  const pressed = useViewStore((s) => artifactShown(s, sessionId, entry.artifactId))
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

  const form = FORMS[entry.action]
  const deletion = entry.action === 'delete'
  const update = form === 'updated'
  const kind = summary ? artifactKind(summary) : null
  const from = update ? versionBefore(entry, sessionId, versions) : null
  // Worked out once the versions say which one the turn started from.
  const changes = useChanges(
    entry.artifactId,
    from,
    entry.version,
    update && inView && versions !== null && standing === 'live',
  )
  const range = from !== null && entry.version !== null ? { from, to: entry.version } : null
  // The frame the open viewer's pill is at, which this card rings while it shows the artifact.
  const walkAt = useArtifactWalk((s) => (pressed ? (s.at[entry.artifactId] ?? null) : null))
  const open = () => {
    if (!pressed) landArtifact(sessionId, entry.artifactId, { range })
    openArtifactTab(sessionId, entry.artifactId, PREVIEW)
  }
  let what = ''
  if (entry.action !== 'delete' && entry.version !== null) {
    what =
      entry.action === 'restore' && restoredFrom !== null && entry.writes === 1
        ? t('artifactEntry.restoredVersion', { version: restoredFrom })
        : [
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
    <div
      ref={card}
      className={cn('k-art-room w-full', className)}
      // A double click keeps the tab the first click opened.
      onDoubleClick={() => openArtifactTab(sessionId, entry.artifactId)}
    >
      <ArtifactCard
        id={entry.artifactId}
        title={entry.title}
        summary={summary}
        standing={standing}
        form={form}
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
        changes={
          changes && entry.version !== null ? (
            <ChangedLine
              changes={changes}
              artifactId={entry.artifactId}
              version={entry.version}
              summary={summary}
              inView={inView}
              ringed={walkAt}
              onFrame={(frame) => {
                landArtifact(sessionId, entry.artifactId, {
                  range,
                  place: { kind: 'frame', id: frame.id },
                  open: true,
                })
                openArtifactTab(sessionId, entry.artifactId, PREVIEW)
              }}
            />
          ) : null
        }
        current={last}
        pressed={pressed}
        onOpen={open}
        menu={{
          onOpen: () => {
            if (!pressed) landArtifact(sessionId, entry.artifactId, { range })
            openArtifactTab(sessionId, entry.artifactId)
          },
          onVersionHistory: () => openArtifact(entry.artifactId, { history: true }),
          inSession: true,
        }}
      />
    </div>
  )
}

/** The most frames or chips the line shows before the rest go into a count. */
const SHOWN = 4

/** An update's line of what changed: its frames as pictures, else a label and chips. */
function ChangedLine({
  changes,
  artifactId,
  version,
  summary,
  inView,
  ringed,
  onFrame,
}: {
  changes: Changes
  artifactId: string
  version: number
  summary: ArtifactSummary | null
  inView: boolean
  ringed: string | null
  onFrame: (frame: ChangedFrame) => void
}) {
  const { t } = useTranslation('session')
  if (changes.kind === 'frames') {
    const { frames } = changes
    return (
      <span
        role="group"
        aria-label={t('artifactEntry.changes.frames', { count: frames.length })}
        className="contents"
      >
        {frames.slice(0, SHOWN).map((frame) => (
          <FrameTile
            key={frame.id}
            frame={frame}
            artifactId={artifactId}
            version={version}
            summary={summary}
            inView={inView}
            on={ringed === frame.id}
            onOpen={() => onFrame(frame)}
          />
        ))}
        {frames.length > SHOWN && (
          <span className="k-art__frame-more">
            {t('artifactEntry.changes.more', { count: frames.length - SHOWN })}
          </span>
        )}
      </span>
    )
  }
  let label: string
  let chips: { key: string; text: string; path?: string }[]
  if (changes.kind === 'files') {
    label = t('artifactEntry.changes.files', { count: changes.paths.length })
    chips = changes.paths.map((path) => ({ key: path, text: path, path }))
  } else if (changes.kind === 'sections') {
    // Counted as the viewer's pill and History count it, by passage.
    label = changesLabel(changes)
    chips = changes.headings.map((heading, i) => ({
      key: `${i}`,
      text: heading ?? t('artifactEntry.changes.start'),
    }))
  } else {
    label = t('artifactEntry.changes.slides', { count: changes.slides.length })
    chips = changes.slides.map((slide) => ({
      key: `${slide.number}`,
      text: t('artifactEntry.changes.slide', { number: slide.number }),
    }))
  }
  return (
    <>
      <span className="k-art__changed-label">{label}</span>
      {chips.slice(0, SHOWN).map((chip) => (
        <span key={chip.key} className="k-art__chip" data-words={chip.path ? undefined : ''}>
          {chip.path && <FileTypeIcon path={chip.path} className="size-3.5" />}
          <span>{chip.text}</span>
        </span>
      ))}
      {chips.length > SHOWN && (
        <span className="k-art__chip" data-words="">
          {t('artifactEntry.changes.more', { count: chips.length - SHOWN })}
        </span>
      )}
    </>
  )
}

const TILE_WIDTH = 84
const TILE_HEIGHT = 52

/**
 * A changed frame as the part of the new version's picture it fills, cut to the tile from its top;
 * a plain tile when the picture does not hold it, as a frame on another canvas.
 */
function FrameTile({
  frame,
  artifactId,
  version,
  summary,
  inView,
  on,
  onOpen,
}: {
  frame: ChangedFrame
  artifactId: string
  version: number
  summary: ArtifactSummary | null
  inView: boolean
  on: boolean
  onOpen: () => void
}) {
  const { t } = useTranslation('session')
  const thumbnail = useThumbnail(
    {
      id: artifactId,
      version,
      pages: summary?.pages ?? 0,
      canvas: summary?.canvas ?? false,
    },
    inView && summary !== null,
  )
  const box =
    thumbnail.state === 'ready' ? thumbnail.pages?.find((page) => page.file === frame.file) : null
  // The version's picture holds only its first canvas page; a frame elsewhere is drawn on its own.
  const parts = usePartThumbnails(artifactId)
  const own = usePartThumbnail(
    artifactId,
    version,
    { frame: frame.id },
    inView && parts && thumbnail.state !== 'loading' && !box,
  )
  return (
    <button
      type="button"
      className="k-art__frame"
      data-on={on ? '' : undefined}
      aria-pressed={on}
      aria-label={t('artifactEntry.changes.showFrame', { name: frame.name })}
      onClick={onOpen}
    >
      <span className="k-art__frame-pic" data-blank={box || own.state === 'ready' ? undefined : ''}>
        {box && thumbnail.state === 'ready' ? (
          <img src={thumbnail.src} alt="" draggable={false} style={cropOf(box)} />
        ) : (
          own.state === 'ready' && (
            <img src={own.src} alt="" draggable={false} className="k-art__frame-own" />
          )
        )}
      </span>
      <span className="k-art__frame-name">{frame.name}</span>
    </button>
  )
}

/** Where the picture lies so the box covers the tile, centred across and from its top. */
function cropOf(box: PageBox): CSSProperties {
  const width = box.width * THUMBNAIL_WIDTH
  const height = box.height * THUMBNAIL_HEIGHT
  const scale = Math.max(TILE_WIDTH / width, TILE_HEIGHT / height)
  return {
    width: THUMBNAIL_WIDTH * scale,
    height: THUMBNAIL_HEIGHT * scale,
    left: (TILE_WIDTH - width * scale) / 2 - box.left * THUMBNAIL_WIDTH * scale,
    top: -box.top * THUMBNAIL_HEIGHT * scale,
  }
}
