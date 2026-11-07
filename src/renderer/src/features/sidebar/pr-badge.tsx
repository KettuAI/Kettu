import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionPullRequest, SessionSummary } from '@shared/agent-host'
import type { GitHubReference, PullRequestState } from '@shared/git'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { ReferenceHoverCard } from '@renderer/features/git/gh-reference'
import { PrIcon } from '@renderer/features/git/pr-icon'
import { prStateText } from '@renderer/features/git/pr-text'
import { shortAgo } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { loadReference, useGitStore, watchReference } from '@renderer/stores/git'
import { sessionPullRequests } from './session-prs'

// The most that the list shows; the rest are counted under it.
const LISTED = 8
// The state that still needs someone comes first, so purple means every one is merged.
const ORDER: PullRequestState[] = ['open', 'draft', 'merged', 'closed']

function topState(prs: SessionPullRequest[]): PullRequestState | null {
  return ORDER.find((state) => prs.some((pr) => pr.state === state)) ?? null
}

function referenceOf(pr: SessionPullRequest): GitHubReference {
  return { kind: 'pull', owner: pr.owner, repo: pr.repo, number: pr.number, url: pr.url }
}

/** What a screen reader hears for the badge: how many, and what they are. */
function useBadgeLabel(prs: SessionPullRequest[]): string {
  const { t } = useTranslation('sidebar')
  const failing = prs.filter((pr) => pr.failing).length
  const states = new Set(prs.map((pr) => pr.state))
  const state =
    states.size === 1 && !states.has(null) ? prStateText([...states][0] as PullRequestState) : null
  return [
    t('prs.count', { count: prs.length }),
    state && (prs.length === 1 ? state : t('prs.all', { state })),
    failing > 0 && t('prs.failing', { count: failing }),
  ]
    .filter(Boolean)
    .join(t('prs.separator'))
}

/**
 * A session's pull requests on its row: the icon of the one that most needs someone, the count
 * when there are several, and a red dot for failing checks. On hover, the card of the one, or the
 * list of them.
 */
export function PrBadge({
  summary,
  onEnter,
}: {
  summary: SessionSummary
  /** The pointer came onto the badge, whose card takes the place of the row's own. */
  onEnter: () => void
}) {
  const prs = sessionPullRequests(summary)
  const label = useBadgeLabel(prs)
  const self = useRef<HTMLSpanElement>(null)
  // The host keeps the ones that can still change current while the row is shown.
  const openUrls = prs
    .filter((pr) => pr.state === null || pr.state === 'open' || pr.state === 'draft')
    .map((pr) => pr.url)
    .join('\n')
  useEffect(() => {
    const releases = openUrls === '' ? [] : openUrls.split('\n').map(watchReference)
    return () => releases.forEach((release) => release())
  }, [openUrls])
  // Beside the sidebar, as the row's own card is, so it hides none of the rows.
  const row = () => self.current?.closest('[data-sidebar-row]') ?? self.current
  if (prs.length === 0) return null
  const failing = prs.some((pr) => pr.failing)
  const content: ReactNode = (
    <>
      <PrIcon state={topState(prs)} size={13} />
      {failing && (
        <span
          aria-hidden
          className="absolute top-[2px] left-[11px] size-1.5 rounded-full bg-danger shadow-[0_0_0_1.5px_var(--bg-sidebar)]"
        />
      )}
      {prs.length > 1 && prs.length}
    </>
  )
  const badge = (
    // As an image, its label goes into the name of the row's button around it.
    <span
      ref={self}
      role="img"
      aria-label={label}
      data-pr-badge=""
      onPointerEnter={onEnter}
      className="relative inline-flex h-5 shrink-0 items-center gap-[3px] rounded-[5px] px-[3px] text-[12px] font-normal text-tertiary tabular-nums hover:bg-selected data-popup-open:bg-selected"
    >
      {content}
    </span>
  )
  if (prs.length === 1) {
    return <ReferenceHoverCard reference={referenceOf(prs[0]!)} side="right" trigger={badge} />
  }
  return (
    <HoverCard>
      <HoverCardTrigger delay={400} closeDelay={200} render={badge} />
      <HoverCardContent
        side="right"
        align="start"
        sideOffset={10}
        anchor={row}
        className="w-[340px] p-1.5"
      >
        <PrList prs={prs} />
      </HoverCardContent>
    </HoverCard>
  )
}

function PrList({ prs }: { prs: SessionPullRequest[] }) {
  const { t } = useTranslation('sidebar')
  const listed = prs.slice(0, LISTED)
  return (
    <>
      <div className="px-2 pt-1.5 pb-1 text-small font-medium text-tertiary">
        {t('prs.title', { count: prs.length })}
      </div>
      <ul className="flex flex-col">
        {listed.map((pr) => (
          <li key={pr.url}>
            <PrListItem pr={pr} />
          </li>
        ))}
      </ul>
      {prs.length > LISTED && (
        <div className="px-2 pt-1 pb-1.5 text-small text-tertiary">
          {t('prs.more', { count: prs.length - LISTED })}
        </div>
      )}
    </>
  )
}

function PrListItem({ pr }: { pr: SessionPullRequest }) {
  const now = useNow()
  const reference = useMemo(() => referenceOf(pr), [pr])
  const details = useGitStore((s) => s.pullRequests[pr.url])
  useEffect(() => loadReference(reference), [reference])
  const state = details?.state ?? pr.state
  const at = details
    ? details.state === 'merged'
      ? details.mergedAt
      : details.state === 'closed'
        ? details.closedAt
        : details.createdAt || null
    : null
  return (
    <ReferenceHoverCard
      reference={reference}
      side="right"
      trigger={
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className="flex h-8 min-w-0 items-center gap-2 rounded-lg px-2 text-small text-primary no-underline outline-none hover:bg-hover focus-ring data-popup-open:bg-hover"
        >
          <PrIcon state={state} size={14} />
          <span className="shrink-0 text-tertiary tabular-nums">
            {pr.repo}#{pr.number}
          </span>
          <span className={cn('min-w-0 flex-1 truncate', !details && 'text-tertiary')}>
            {details?.title ?? ''}
          </span>
          {at !== null && (
            <span className="shrink-0 text-xs text-tertiary">{shortAgo(at, now)}</span>
          )}
        </a>
      }
    />
  )
}
