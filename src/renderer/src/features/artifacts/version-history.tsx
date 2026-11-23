import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown01Icon, Clock01Icon, Globe02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { ArtifactChanges } from '@shared/artifact-changes'
import type { VersionSummary } from '@shared/artifacts'
import { Icon } from '@renderer/components/affect/app-shell'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { longAgo } from '@renderer/lib/format'
import { host } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { setViewerState } from '@renderer/stores/artifact-viewer'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { artifactSharing, useArtifactRecord } from './artifact-host'
import { changeLine } from './change-words'
import { CardHead } from './tool-parts'
import { useAuthor } from './use-versions'

/** The most rows whose changes are read. */
const READ_ROWS = 40

/** What a version changed against the one before, read once per artifact and version. */
const changesRead = new Map<string, Promise<ArtifactChanges | null>>()

function changesOf(id: string, version: number): Promise<ArtifactChanges | null> {
  const key = `${id}:${version}`
  let read = changesRead.get(key)
  if (!read) {
    read = host('artifacts.changes', { id, from: version - 1, to: version }).then(
      ({ changes }) => changes,
      () => null,
    )
    changesRead.set(key, read)
  }
  return read
}

/** A row: one version, or a run of the user's own edits folded into one. */
type Row = { kind: 'one'; version: VersionSummary } | { kind: 'run'; versions: VersionSummary[] }

function rowsOf(versions: readonly VersionSummary[]): Row[] {
  const rows: Row[] = []
  for (const v of versions) {
    const last = rows.at(-1)
    const mine = v.author === null && v.note === null
    if (mine && last) {
      const lastMine =
        last.kind === 'run' ||
        (last.kind === 'one' && last.version.author === null && last.version.note === null)
      if (lastMine) {
        const run = last.kind === 'run' ? last.versions : [last.version]
        rows[rows.length - 1] = { kind: 'run', versions: [...run, v] }
        continue
      }
    }
    rows.push({ kind: 'one', version: v })
  }
  return rows
}

/**
 * The History card: every version, newest first, with who wrote it, its note, when, and what it
 * changed; the latest and the published one marked, and a run of the user's own edits folded.
 * A click shows that version in place; the arrow keys walk them.
 */
export function VersionHistory({
  id,
  versions,
  error,
  shown,
  published,
  changes,
  onPick,
}: {
  id: string
  versions: VersionSummary[] | null
  error: string | null
  /** The version on screen, or null for the latest. */
  shown: number | null
  /** The version the published page shows. */
  published: number | null
  /** Whether the host compares versions. */
  changes: boolean
  onPick: (version: number) => void
}) {
  const { t } = useTranslation('artifacts')
  const head = versions?.[0]?.version ?? null
  const on = shown ?? head
  const rows = useMemo(() => (versions ? rowsOf(versions) : []), [versions])
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set())
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    list.current
      ?.querySelector('[aria-current="true"]')
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [on])

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!versions || on === null || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
    const at = versions.findIndex((v) => v.version === on)
    const next = versions[at + (event.key === 'ArrowDown' ? 1 : -1)]
    if (!next) return
    event.preventDefault()
    onPick(next.version)
    requestAnimationFrame(() =>
      list.current?.querySelector<HTMLElement>(`[data-version="${next.version}"]`)?.focus(),
    )
  }

  const sub = versions
    ? [
        t('history.count', { count: versions.length }),
        ...(published !== null ? [t('history.published')] : []),
      ].join(' · ')
    : undefined

  return (
    <aside aria-label={t('history.title')} className="k-av-side k-vt-card">
      <CardHead icon={Clock01Icon} title={t('history.title')} sub={sub} />
      <div ref={list} role="list" className="k-vt-list k-vt-hist" onKeyDown={onKeyDown}>
        {error && !versions && <p className="k-av-error k-vt-pad">{error}</p>}
        {!versions && !error && (
          <div aria-busy className="k-av-side__wait k-vt-pad">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-36" />
          </div>
        )}
        {rows.map((row, i) => {
          if (row.kind === 'one') {
            return (
              <VersionRow
                key={row.version.version}
                id={id}
                version={row.version}
                current={row.version.version === head}
                published={row.version.version === published}
                on={row.version.version === on}
                changes={changes && i < READ_ROWS}
                onPick={onPick}
              />
            )
          }
          const first = row.versions[0]!
          const expanded = open.has(first.version)
          const inside = row.versions.some((v) => v.version === on)
          return (
            <div key={`run-${first.version}`} role="listitem" className="k-vt-run">
              <VersionRow
                id={id}
                version={first}
                title={t('history.yourEdits')}
                current={first.version === head}
                published={row.versions.some((v) => v.version === published)}
                on={first.version === on || (!expanded && inside)}
                changes={false}
                range={`v${row.versions.at(-1)!.version}–v${first.version}`}
                onPick={onPick}
              />
              <button
                type="button"
                aria-expanded={expanded}
                className="k-vt-run__toggle"
                onClick={() =>
                  setOpen((was) => {
                    const next = new Set(was)
                    if (next.has(first.version)) next.delete(first.version)
                    else next.add(first.version)
                    return next
                  })
                }
              >
                <Icon icon={ArrowDown01Icon} size={12} />
                {expanded
                  ? t('history.fold')
                  : t('history.showRun', { count: row.versions.length })}
              </button>
              {expanded &&
                row.versions.map((v) => (
                  <VersionRow
                    key={v.version}
                    id={id}
                    version={v}
                    nested
                    current={v.version === head}
                    published={v.version === published}
                    on={v.version === on}
                    changes={changes}
                    onPick={onPick}
                  />
                ))}
            </div>
          )
        })}
      </div>
      <p className="k-vt-foot__note k-vt-hist__note">{t('history.restoreNote')}</p>
    </aside>
  )
}

function VersionRow({
  id,
  version,
  title,
  current,
  published,
  on,
  changes,
  nested = false,
  range,
  onPick,
}: {
  id: string
  version: VersionSummary
  title?: string
  current: boolean
  published: boolean
  on: boolean
  changes: boolean
  nested?: boolean
  range?: string
  onPick: (version: number) => void
}) {
  const { t } = useTranslation('artifacts')
  const now = useNow()
  const author = useAuthor()
  const session = useSessionsStore((s) =>
    version.author === null ? null : (s.byId[version.author] ?? null),
  )
  const [line, setLine] = useState<string | null>(null)
  useEffect(() => {
    if (!changes || version.version < 2) return
    let live = true
    void changesOf(id, version.version).then((found) => {
      if (live) setLine(found ? changeLine(found) : null)
    })
    return () => {
      live = false
    }
  }, [id, version.version, changes])

  return (
    <button
      type="button"
      role={nested ? undefined : 'listitem'}
      data-version={version.version}
      data-nested={nested || undefined}
      aria-current={on || undefined}
      onClick={() => onPick(version.version)}
      className="k-vt-ver"
    >
      <span className="k-vt-ver__mark" aria-hidden>
        {session ? (
          <AgentMark agent={session.agentId} size={16} hostId={hostOfSession(session)} />
        ) : version.author === null ? (
          <span className="k-vt-you" />
        ) : (
          <span className="k-vt-unknown" />
        )}
      </span>
      <span className="k-vt-ver__text">
        <span className="k-vt-ver__top">
          <b title={title ?? version.note ?? author(version.author)}>
            {title ?? version.note ?? author(version.author)}
          </b>
          {current && (
            <span className="k-vt-tag" data-tone="info">
              {t('history.current')}
            </span>
          )}
          {published && (
            <span className="k-vt-pub" title={t('history.publishedHere')}>
              <Icon icon={Globe02Icon} size={14} />
            </span>
          )}
        </span>
        <span className="k-vt-ver__line">
          {range ?? t('viewer.version', { version: version.version })} ·{' '}
          {longAgo(version.createdAt, now)}
        </span>
        {line && <span className="k-vt-ver__line k-vt-ver__changes">{line}</span>}
      </span>
    </button>
  )
}

/** The History card, with what the host keeps for it. */
export function HistoryCard({
  id,
  versions,
  error,
  shown,
  head,
}: {
  id: string
  versions: VersionSummary[] | null
  error: string | null
  shown: number | null
  head: number | null
}) {
  const changes = useArtifactRecord(id, 'changes')
  const published = artifactSharing(id).useSharingStore(
    (s) => s.status?.published.find((page) => page.id === id)?.version ?? null,
  )
  return (
    <VersionHistory
      id={id}
      versions={versions}
      error={error}
      shown={shown}
      published={published}
      changes={changes}
      onPick={(version) => setViewerState(id, { version: version === head ? null : version })}
    />
  )
}
