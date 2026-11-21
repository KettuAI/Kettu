import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionOutputs, SessionSummary } from '@shared/agent-host'
import type { ArtifactSummary } from '@shared/artifacts'
import { githubReferenceOf, type GitHubReference } from '@shared/git'
import { cn } from 'cn'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { KIND_ICON } from '@renderer/features/artifacts/kinds'
import { artifactKind } from '@renderer/features/artifacts/model'
import { KindSketch } from '@renderer/features/artifacts/sketch'
import { useThumbnail } from '@renderer/features/artifacts/thumbnails'
import '@renderer/features/artifacts/artifact-card.css'
import { ReferenceIcon } from '@renderer/features/git/gh-reference'
import { useReferenceData } from '@renderer/features/git/gh-reference-data'
import { Glyph } from '@renderer/features/shell/glyph'
import { mediumAgo } from '@renderer/lib/format'
import { learnArtifactHost } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { artifactListShown, artifactStanding, useArtifactsStore } from '@renderer/stores/artifacts'
import { loadReference } from '@renderer/stores/git'
import { hostOfSession } from '@renderer/stores/sessions'
import { openArtifact } from '@renderer/stores/view'

const TILES = 2
const ROWS = 3

/**
 * The session's own pull requests, then the references its replies link, latest first, once
 * each.
 */
function referencesOf(summary: SessionSummary, outputs: SessionOutputs): GitHubReference[] {
  const refs: GitHubReference[] = []
  const seen = new Set<string>()
  for (const url of [...(summary.prs ?? []).map((pr) => pr.url), ...outputs.references]) {
    const ref = githubReferenceOf(url)
    const key = ref && `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase()
    if (!ref || !key || seen.has(key)) continue
    seen.add(key)
    refs.push(ref)
  }
  return refs
}

/** The artifacts the session wrote that are still there, latest first. */
function useLiveArtifacts(summary: SessionSummary, outputs: SessionOutputs) {
  useEffect(() => {
    artifactListShown(true)
    return () => artifactListShown(false)
  }, [])
  const hostId = hostOfSession(summary)
  useEffect(() => {
    for (const a of outputs.artifacts) learnArtifactHost(a.id, hostId)
  }, [outputs, hostId])
  const standing = useArtifactsStore((s) =>
    outputs.artifacts.map((a) => artifactStanding(s, a.id)).join(),
  )
  const list = useArtifactsStore((s) => s.list)
  return useMemo(() => {
    const live = standing.split(',')
    return outputs.artifacts
      .filter((_, i) => live[i] === 'live')
      .map((a) => ({ ...a, summary: list?.find((item) => item.id === a.id) ?? null }))
  }, [outputs, standing, list])
}

/**
 * What the session made: its latest artifacts as their pictures, then the pull requests and issues
 * it opened or linked; the start of its last reply when it made neither. Each opens on a click,
 * after `onOpen`, which lets the card close.
 */
export function CardOutputs({
  summary,
  outputs,
  onOpen,
}: {
  summary: SessionSummary
  outputs: SessionOutputs | null
  onOpen?: () => void
}) {
  if (!outputs) {
    return (
      <div className="flex flex-col gap-2 px-3.5 pb-3" aria-hidden>
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    )
  }
  return <Made summary={summary} outputs={outputs} onOpen={onOpen} />
}

function Made({
  summary,
  outputs,
  onOpen,
}: {
  summary: SessionSummary
  outputs: SessionOutputs
  onOpen?: () => void
}) {
  const { t } = useTranslation('sidebar')
  const artifacts = useLiveArtifacts(summary, outputs)
  const refs = useMemo(() => referencesOf(summary, outputs), [summary, outputs])
  const tiles = artifacts.slice(0, TILES)
  const rows = refs.slice(0, ROWS)
  if (tiles.length === 0 && rows.length === 0) {
    const reply = outputs.reply && plain(outputs.reply)
    if (!reply) return null
    return <p className="mx-3.5 mb-3 line-clamp-3 text-small text-secondary">{reply}</p>
  }
  return (
    <div className="flex flex-col gap-3 px-3.5 pb-3">
      {tiles.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {/* One artifact takes the whole width, so the card has no empty half. */}
          <div className={cn('grid gap-2', tiles.length > 1 && 'grid-cols-2')}>
            {tiles.map((a) => (
              <ArtifactTile
                key={a.id}
                id={a.id}
                title={a.title}
                summary={a.summary}
                wide={tiles.length === 1}
                onOpen={onOpen}
              />
            ))}
          </div>
          {artifacts.length > tiles.length && (
            <span className="flex h-[22px] items-center px-0.5 text-small text-tertiary">
              {t('card.moreArtifacts', { count: artifacts.length - tiles.length })}
            </span>
          )}
        </div>
      )}
      {rows.length > 0 && (
        <div className="flex flex-col">
          {rows.map((ref) => (
            <ReferenceRow key={ref.url} reference={ref} onOpen={onOpen} />
          ))}
          {refs.length > rows.length && (
            <span className="flex h-[22px] items-center pl-[22px] text-small text-tertiary">
              {t('card.moreReferences', { count: refs.length - rows.length })}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * An artifact as on the Artifacts page: its picture over its kind's glow, then its title; `wide`
 * crops the picture to a banner and adds its version and age. A click opens it in the viewer.
 */
function ArtifactTile({
  id,
  title,
  summary,
  wide,
  onOpen,
}: {
  id: string
  title: string
  summary: ArtifactSummary | null
  wide: boolean
  onOpen?: () => void
}) {
  const { t } = useTranslation('sidebar')
  const now = useNow()
  const kind = summary ? artifactKind(summary) : null
  const thumbnail = useThumbnail(
    {
      id,
      version: summary?.version ?? 0,
      pages: summary?.pages ?? 0,
      canvas: summary?.canvas ?? false,
    },
    summary !== null,
  )
  return (
    <button
      type="button"
      tabIndex={-1}
      onClick={() => {
        onOpen?.()
        openArtifact(id)
      }}
      className="k-art group flex min-w-0 flex-col gap-1.5 text-left outline-none"
      data-kind={kind ?? undefined}
    >
      <span className="k-art__panel rounded-[10px]! p-[7px]!">
        <span aria-hidden className="k-art__glow">
          <i />
          <i />
          <i />
        </span>
        <span className={cn('k-art__page rounded-[4px]!', wide && 'aspect-[12/5]!')}>
          {thumbnail.state === 'ready' ? (
            <span className="k-th k-th--image">
              <img src={thumbnail.src} alt="" draggable={false} />
            </span>
          ) : thumbnail.state === 'failed' && kind ? (
            <KindSketch kind={kind} title={title} />
          ) : (
            <span className="k-th k-th--loading" />
          )}
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-1 px-0.5 text-small font-medium text-secondary transition-colors duration-(--duration-fast) group-hover:text-primary">
        {kind && (
          // Inline, since the card's unlayered styles would win over a color utility.
          <span className="grid shrink-0" style={{ color: `var(--kind-${kind})` }}>
            <Glyph icon={KIND_ICON[kind]} size={12} />
          </span>
        )}
        <span className="truncate">{title}</span>
        {wide && summary && (
          <span className="ml-auto shrink-0 pl-2 font-normal text-tertiary tabular-nums">
            {t('card.artifactFacts', {
              version: summary.version,
              time: mediumAgo(summary.updatedAt, now),
            })}
          </span>
        )}
      </span>
    </button>
  )
}

/**
 * A pull request or issue as the sidebar's list writes one: its state, repo#number and title; a
 * click opens it on GitHub.
 */
function ReferenceRow({ reference, onOpen }: { reference: GitHubReference; onOpen?: () => void }) {
  const { data } = useReferenceData(reference)
  useEffect(() => loadReference(reference), [reference])
  const title = data ? (data.kind === 'pull' ? data.pr.title : data.issue.title) : null
  return (
    <a
      href={reference.url}
      target="_blank"
      rel="noreferrer"
      tabIndex={-1}
      onClick={onOpen}
      className="-mx-1.5 flex h-6 min-w-0 items-center gap-2 rounded-md px-1.5 text-small no-underline outline-none hover:bg-hover"
    >
      <ReferenceIcon kind={reference.kind} data={data} size={14} />
      <span className="shrink-0 font-medium text-primary tabular-nums">
        {reference.repo}#{reference.number}
      </span>
      {title && <span className="min-w-0 truncate text-tertiary">{title}</span>}
    </a>
  )
}

/** A reply's Markdown as one run of words, for three lines of it. */
function plain(markdown: string): string {
  return (
    markdown
      .replace(/```[\s\S]*?(```|$)/g, ' ')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
      .replace(/`+|\*+|~~/g, '')
      // Underscores that open or close emphasis, keeping those inside names such as KIND_LOOK.
      .replace(/(^|\W)_+(?=\w)|(?<=\w)_+(?=\W|$)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
  )
}
