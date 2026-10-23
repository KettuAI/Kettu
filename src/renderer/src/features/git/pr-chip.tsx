import { useEffect, useRef, useState } from 'react'
import { ExternalLinkIcon } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { GITHUB_PULL_REQUEST_URL, type PullRequest } from '@shared/git'
import { buttonVariants } from '@renderer/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { longAgo } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'
import { loadPullRequest, useGitStore } from '@renderer/stores/git'
import { ChecksIcon, PrIcon } from './pr-icon'
import { prStateText } from './pr-text'

const REVIEW_KEY = {
  approved: 'pr.review.approved',
  changes_requested: 'pr.review.changesRequested',
  review_required: 'pr.review.reviewRequired',
} as const

/** Title, state, branches, checks, review and when it was updated, for the hover card and popover. */
export function PrDetails({ pr }: { pr: PullRequest }) {
  const { t } = useTranslation('git')
  const { checks } = pr
  const when = longAgo(pr.updatedAt)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-start gap-2">
        <PrIcon state={pr.state} size={15} className="mt-px" />
        <span className="min-w-0 flex-1 leading-[1.35] font-medium">{pr.title}</span>
        <span className="font-mono text-xs text-tertiary">#{pr.number}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pl-[23px] text-xs text-tertiary tabular">
        <span>
          <Trans
            t={t}
            i18nKey="pr.summary"
            values={{ state: prStateText(pr.state) }}
            components={{
              head: <span className="font-mono text-[11.5px]">{pr.head}</span>,
              base: <span className="font-mono text-[11.5px]">{pr.base}</span>,
            }}
          />
        </span>
        {checks.passed > 0 && (
          <span className="inline-flex items-center gap-1">
            <ChecksIcon state="passing" size={12} />
            {t('pr.checkCount.passed', { count: checks.passed })}
          </span>
        )}
        {checks.failed > 0 && (
          <span className="inline-flex items-center gap-1">
            <ChecksIcon state="failing" size={12} />
            {t('pr.checkCount.failed', { count: checks.failed })}
          </span>
        )}
        {checks.pending > 0 && (
          <span className="inline-flex items-center gap-1">
            <ChecksIcon state="pending" size={12} />
            {t('pr.checkCount.pending', { count: checks.pending })}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 pl-[23px] text-xs text-tertiary">
        <span className="flex-1">
          {pr.review
            ? t('pr.reviewUpdated', { review: t(REVIEW_KEY[pr.review]), when })
            : t('pr.updated', { when })}
        </span>
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className={cn(buttonVariants({ variant: 'ghost', size: 'xs' }), '-mr-1.5')}
        >
          <ExternalLinkIcon data-icon="inline-start" />
          {t('pr.openOnGitHub')}
        </a>
      </div>
    </div>
  )
}

/**
 * A pull request link as a chip: neutral, with only the state icon in color. Details load the
 * first time the chip scrolls into view; without gh it still opens the link.
 */
export function PrChip({ url, className }: { url: string; className?: string }) {
  const match = GITHUB_PULL_REQUEST_URL.exec(url)
  const pr = useGitStore((s) => s.pullRequests[url])
  const ref = useRef<HTMLAnchorElement>(null)
  const [seen, setSeen] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el || seen) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setSeen(true)
        observer.disconnect()
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [seen])

  useEffect(() => {
    if (seen) void loadPullRequest(url)
  }, [seen, url])

  if (!match) return null
  const [, owner, repo, number] = match
  const title = pr?.title ? (pr.title.length > 40 ? pr.title.slice(0, 40) + '…' : pr.title) : null

  const chip = (
    <a
      ref={ref}
      href={url}
      target="_blank"
      rel="noreferrer"
      className={cn(
        'inline-flex h-[22px] max-w-full items-center gap-1.5 rounded-[6px] bg-subtle pr-2 pl-1.5 align-[-5px] text-control leading-none text-primary no-underline shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)] transition-colors duration-(--duration-fast) hover:bg-hover hover:shadow-[inset_0_0_0_var(--hairline)_var(--border-default)]',
        className,
      )}
    >
      <PrIcon state={pr?.state ?? null} size={13} />
      <span className="font-mono text-xs whitespace-nowrap">
        {owner}/{repo}#{number}
      </span>
      {title && <span className="min-w-0 truncate text-tertiary">{title}</span>}
      {pr && <ChecksIcon state={pr.checks.state} size={12} />}
    </a>
  )

  if (!pr) return chip
  return (
    <HoverCard>
      <HoverCardTrigger render={chip} delay={400} />
      <HoverCardContent className="w-[340px] p-3">
        <PrDetails pr={pr} />
      </HoverCardContent>
    </HoverCard>
  )
}
