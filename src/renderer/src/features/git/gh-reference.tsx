import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Alert02Icon,
  CheckmarkCircle01Icon,
  Comment01Icon,
  File01Icon,
  GitPullRequestIcon,
  RadioButtonIcon,
  RotateClockwiseIcon,
  UnavailableIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { Trans, useTranslation } from 'react-i18next'
import {
  githubReferenceOf,
  type GitHubReference,
  type Issue,
  type IssueState,
  type PullRequest,
  type PullRequestAuthor,
} from '@shared/git'
import { Avatar, AvatarFallback, AvatarImage } from '@renderer/components/ui/avatar'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { longAgo } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import {
  isReferenceSettled,
  loadAvatar,
  loadReference,
  retryReference,
  useGitStore,
  watchReference,
} from '@renderer/stores/git'
import { CopyButton } from './copy-button'
import {
  shortReference,
  useProjectRepository,
  useReferenceData,
  type ReferenceData,
} from './gh-reference-data'
import { authorLabel } from './pr-author'
import { ChecksIcon, PrIcon, ReviewIcon, type IconSize } from './pr-icon'
import { checkCountText, prStateText, REVIEW_KEY } from './pr-text'

const ICON_SIZE = { 12: 'size-3', 13: 'size-3.25', 14: 'size-3.5', 16: 'size-4' } as const
const STROKE = 1.9
// The title after a bare address, cut so a reference never takes over its line.
const TITLE_CHARS = 48

const ISSUE = {
  open: { Icon: RadioButtonIcon, color: 'text-success' },
  completed: { Icon: CheckmarkCircle01Icon, color: 'text-merged' },
  not_planned: { Icon: UnavailableIcon, color: 'text-icon' },
} as const

const ISSUE_STATE_KEY = {
  open: 'ref.issueState.open',
  completed: 'ref.issueState.completed',
  not_planned: 'ref.issueState.notPlanned',
} as const

/** The state's icon in its color; gray, of the reference's kind, until gh has answered. */
export function ReferenceIcon({
  kind,
  data,
  size = 14,
  className,
}: {
  kind: GitHubReference['kind']
  data: ReferenceData | null
  size?: IconSize
  className?: string
}) {
  const { t } = useTranslation('git')
  if (data?.kind === 'pull')
    return <PrIcon state={data.pr.state} size={size} className={className} />
  const state: IssueState | null = data?.kind === 'issue' ? data.issue.state : null
  const icon = state ? ISSUE[state].Icon : kind === 'pull' ? GitPullRequestIcon : RadioButtonIcon
  const label = state
    ? t('ref.issueIcon', { state: t(ISSUE_STATE_KEY[state]) })
    : t(kind === 'pull' ? 'pr.icon.none' : 'ref.issue')
  return (
    <HugeiconsIcon
      icon={icon}
      size={size}
      strokeWidth={STROKE}
      role="img"
      aria-label={label}
      className={cn(
        'shrink-0',
        ICON_SIZE[size],
        state ? ISSUE[state].color : 'text-icon',
        className,
      )}
    />
  )
}

function titleOf(data: ReferenceData | null): string | null {
  if (!data) return null
  return data.kind === 'pull' ? data.pr.title : data.issue.title
}

function clip(title: string): string {
  const chars = [...title]
  return chars.length > TITLE_CHARS ? chars.slice(0, TITLE_CHARS - 1).join('') + '…' : title
}

/**
 * Loads a reference's details the first time it scrolls into view, and has the host keep an open
 * one current for as long as it stays in view.
 */
function useReferenceOnScreen(ref: GitHubReference) {
  const target = useRef<HTMLSpanElement>(null)
  const [seen, setSeen] = useState(false)
  const [inView, setInView] = useState(false)
  const settled = useGitStore((s) => isReferenceSettled(s, ref))
  useEffect(() => {
    const el = target.current
    if (!el) return
    const observer = new IntersectionObserver((entries) => {
      const latest = entries.at(-1)
      if (!latest) return
      setInView(latest.isIntersecting)
      if (latest.isIntersecting) setSeen(true)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (seen) loadReference(ref)
  }, [seen, ref])
  const { url } = ref
  useEffect(() => (inView && !settled ? watchReference(url) : undefined), [inView, settled, url])
  return target
}

/**
 * A reference's text inside its link: the state icon, then the agent's own words, or for a bare
 * address the short form and the title.
 */
export function ReferenceText({
  reference,
  bare,
  children,
}: {
  reference: GitHubReference
  bare: boolean
  children: ReactNode
}) {
  const target = useReferenceOnScreen(reference)
  const { data } = useReferenceData(reference)
  const repo = useProjectRepository()
  const title = bare ? titleOf(data) : null
  return (
    <>
      <span ref={target} className="whitespace-nowrap">
        <ReferenceIcon
          kind={reference.kind}
          data={data}
          size={14}
          className="relative -top-[1.5px] mr-1 inline-block align-middle"
        />
        {bare ? <span className="font-medium">{shortReference(reference, repo)}</span> : null}
      </span>
      {bare ? title && <span className="text-tertiary"> · {clip(title)}</span> : children}
    </>
  )
}

function Author({ author }: { author: PullRequestAuthor }) {
  const { t } = useTranslation('git')
  const picture = useGitStore((s) => s.avatars[author.login])
  const { name, login, initial } = authorLabel(author)
  useEffect(() => loadAvatar(author.login), [author.login])
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Avatar aria-hidden className="size-5 after:border-subtle">
        {picture && <AvatarImage src={picture} alt="" />}
        <AvatarFallback className="bg-subtle text-meta leading-none font-medium text-secondary">
          {initial}
        </AvatarFallback>
      </Avatar>
      {/* One run, so a long pair cuts the login before the name. */}
      <span className="min-w-0 truncate text-small">
        <span className="font-medium">{name}</span>
        {login && <span className="ml-2 text-xs text-tertiary">{login}</span>}
      </span>
      {author.bot && (
        <Badge variant="outline" className="h-4 rounded-sm px-1.25 py-0 text-tertiary">
          {t('prCard.bot')}
        </Badge>
      )}
    </div>
  )
}

const PILL = {
  open: 'bg-[color-mix(in_srgb,var(--success)_13%,transparent)] text-success',
  merged: 'bg-[color-mix(in_srgb,var(--merged)_13%,transparent)] text-merged',
  closed: 'bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-danger',
  gray: 'bg-hover text-secondary',
} as const

function Pill({ tone, children }: { tone: keyof typeof PILL; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex h-5.5 shrink-0 items-center gap-1.25 rounded-md pr-2 pl-1.75 text-xs font-medium',
        PILL[tone],
      )}
    >
      {children}
    </span>
  )
}

function Head({
  reference,
  data,
  pill,
  when,
}: {
  reference: GitHubReference
  data: ReferenceData | null
  pill: ReactNode
  when: string | null
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {pill ?? (
        <Pill tone="gray">
          <ReferenceIcon kind={reference.kind} data={data} size={13} className="text-current" />
        </Pill>
      )}
      <span className="min-w-0 truncate text-xs text-tertiary">
        {reference.owner}/{reference.repo} #{reference.number}
      </span>
      {when && (
        <span className="ml-auto shrink-0 text-xs whitespace-nowrap text-tertiary tabular">
          {when}
        </span>
      )}
    </div>
  )
}

function Title({ url, title }: { url: string; title: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={title}
      className="line-clamp-3 rounded-sm font-heading text-subheading leading-snug font-medium text-primary no-underline underline-offset-2 focus-ring hover:underline"
    >
      {title}
    </a>
  )
}

function Stat({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-tertiary tabular">
      {children}
    </span>
  )
}

function PullRequestDetails({ reference, pr }: { reference: GitHubReference; pr: PullRequest }) {
  const { t } = useTranslation('git')
  const now = useNow()
  const live = pr.state === 'open' || pr.state === 'draft'
  // The pill says which time this is: merged, closed, or opened.
  const at =
    pr.state === 'merged' ? pr.mergedAt : pr.state === 'closed' ? pr.closedAt : pr.createdAt
  const when = at ? longAgo(at, now) : null
  const tone = { open: 'open', draft: 'gray', merged: 'merged', closed: 'closed' } as const
  return (
    <>
      <Head
        reference={reference}
        data={{ kind: 'pull', pr }}
        when={when}
        pill={
          <Pill tone={tone[pr.state]}>
            <PrIcon state={pr.state} size={13} className="text-current" />
            {prStateText(pr.state)}
          </Pill>
        }
      />
      <Title url={pr.url} title={pr.title} />
      <div className="-mt-1.5 text-xs text-tertiary">
        {/* The branches move to a line of their own together, and break only when longer. */}
        <span className="inline-block max-w-full wrap-anywhere">
          <span className="font-mono text-meta">{pr.head}</span> →{' '}
          <span className="font-mono text-meta">{pr.base}</span>
        </span>
      </div>
      {live && (pr.checks.state !== 'none' || pr.review || pr.mergeable === 'conflicting') && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-secondary tabular">
          {pr.checks.state !== 'none' && (
            <span className="inline-flex items-center gap-1">
              <ChecksIcon state={pr.checks.state} size={12} />
              {checkCountText(pr.checks)}
            </span>
          )}
          {pr.review && (
            <span className="inline-flex items-center gap-1">
              <ReviewIcon review={pr.review} size={12} />
              {t(REVIEW_KEY[pr.review])}
            </span>
          )}
          {pr.mergeable === 'conflicting' && (
            <span className="inline-flex items-center gap-1">
              <HugeiconsIcon
                icon={Alert02Icon}
                strokeWidth={STROKE}
                aria-hidden
                className="size-3 text-warning"
              />
              {t('prPart.blocked.conflicts', { base: pr.base })}
            </span>
          )}
        </div>
      )}
      <div className="flex min-w-0 items-center gap-3">
        <div className="min-w-0 flex-1">{pr.author && <Author author={pr.author} />}</div>
        {pr.additions + pr.deletions > 0 && (
          <Stat>
            <span className="text-(--thread-add)">+{pr.additions.toLocaleString()}</span>
            <span className="text-(--thread-del)">−{pr.deletions.toLocaleString()}</span>
          </Stat>
        )}
        {pr.changedFiles > 0 && (
          <Stat>
            <HugeiconsIcon icon={File01Icon} strokeWidth={STROKE} aria-hidden className="size-3" />
            {t('ref.files', { count: pr.changedFiles })}
          </Stat>
        )}
      </div>
    </>
  )
}

function IssueDetails({ reference, issue }: { reference: GitHubReference; issue: Issue }) {
  const { t } = useTranslation('git')
  const now = useNow()
  const repo = useProjectRepository()
  const at = issue.state === 'open' ? issue.createdAt : issue.closedAt
  const when = at ? longAgo(at, now) : null
  const tone = { open: 'open', completed: 'merged', not_planned: 'gray' } as const
  const closedBy = issue.closedBy ? githubReferenceOf(issue.closedBy.url) : null
  const more = issue.labelCount - issue.labels.length
  return (
    <>
      <Head
        reference={reference}
        data={{ kind: 'issue', issue }}
        when={when}
        pill={
          <Pill tone={tone[issue.state]}>
            <ReferenceIcon
              kind="issue"
              data={{ kind: 'issue', issue }}
              size={13}
              className="text-current"
            />
            {t(ISSUE_STATE_KEY[issue.state])}
          </Pill>
        }
      />
      <Title url={issue.url} title={issue.title} />
      {closedBy && issue.closedBy && (
        <div className="flex items-center gap-1 text-xs text-secondary">
          {t('ref.closedBy')}
          <a
            href={closedBy.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-sm font-medium text-primary no-underline focus-ring hover:underline"
          >
            <PrIcon state={issue.closedBy.state} size={12} />
            {shortReference(closedBy, repo)}
          </a>
        </div>
      )}
      {issue.labels.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {issue.labels.map((label) => (
            <span
              key={label.name}
              className="inline-flex h-5 max-w-40 items-center gap-1.25 rounded-full px-1.75 text-xs text-secondary shadow-[inset_0_0_0_var(--hairline)_var(--border-default)]"
            >
              {label.color && (
                <span
                  aria-hidden
                  className="size-1.75 shrink-0 rounded-full"
                  style={{ backgroundColor: `#${label.color}` }}
                />
              )}
              <span className="truncate">{label.name}</span>
            </span>
          ))}
          {more > 0 && <span className="text-xs text-tertiary tabular">+{more}</span>}
        </div>
      )}
      <div className="flex min-w-0 items-center gap-3">
        <div className="min-w-0 flex-1">{issue.author && <Author author={issue.author} />}</div>
        <Stat>
          <HugeiconsIcon icon={Comment01Icon} strokeWidth={STROKE} aria-hidden className="size-3" />
          {t('ref.comments', { count: issue.comments })}
        </Stat>
      </div>
    </>
  )
}

function Loading() {
  return (
    <>
      <div className="flex items-center gap-2">
        <Skeleton className="h-5.5 w-16 rounded-md" />
        <Skeleton className="h-2.5 w-28" />
        <Skeleton className="ml-auto h-2.5 w-12" />
      </div>
      <div className="flex flex-col gap-1.75 pt-0.5">
        <Skeleton className="h-3.25 w-11/12" />
        <Skeleton className="h-3.25 w-7/12" />
      </div>
      <Skeleton className="h-2.5 w-1/2" />
      <div className="flex items-center gap-2">
        <Skeleton className="size-5 rounded-full" />
        <Skeleton className="h-2.5 w-20" />
        <Skeleton className="ml-auto h-2.5 w-20" />
      </div>
    </>
  )
}

function Missing({ reference, error }: { reference: GitHubReference; error: string | null }) {
  const { t } = useTranslation('git')
  const gh = useGitStore((s) => s.tools?.gh.state ?? null)
  const [retrying, setRetrying] = useState(false)
  return (
    <>
      <Head reference={reference} data={null} pill={null} when={null} />
      {gh === 'not-installed' ? (
        <p className="text-small text-secondary">
          <Trans
            t={t}
            i18nKey="ref.installGh"
            components={{
              cli: (
                <a
                  href="https://cli.github.com"
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-border-strong underline-offset-2 hover:text-primary hover:decoration-current"
                />
              ),
            }}
          />
        </p>
      ) : gh === 'signed-out' ? (
        <div className="flex flex-col items-start gap-2 text-small text-secondary">
          <p>{t('ref.signInGh')}</p>
          <span className="inline-flex items-center gap-1">
            <code className="rounded-sm bg-code-inline px-1.5 py-0.5 font-mono text-meta text-code-inline">
              gh auth login
            </code>
            <CopyButton text="gh auth login" label={t('prPart.copyCommand')} />
          </span>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-2">
          <p className="text-small text-secondary">{t('ref.unreadable')}</p>
          {error && <p className="font-mono text-meta text-tertiary wrap-anywhere">{error}</p>}
          <Button
            variant="outline"
            size="xs"
            disabled={retrying}
            onClick={() => {
              setRetrying(true)
              void retryReference(reference).finally(() => setRetrying(false))
            }}
          >
            {retrying ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <HugeiconsIcon
                icon={RotateClockwiseIcon}
                strokeWidth={STROKE}
                data-icon="inline-start"
              />
            )}
            {t('prCard.retry')}
          </Button>
        </div>
      )}
    </>
  )
}

/** A reference's card: what it is, its state and its author, or why that is not known. */
export function ReferenceCard({ reference }: { reference: GitHubReference }) {
  const { data, error } = useReferenceData(reference)
  const gh = useGitStore((s) => s.tools?.gh.state ?? null)
  // Shown again a while later, a live one is read again behind what it shows.
  useEffect(() => loadReference(reference, true), [reference])
  if (data?.kind === 'pull') return <PullRequestDetails reference={reference} pr={data.pr} />
  if (data?.kind === 'issue') return <IssueDetails reference={reference} issue={data.issue} />
  if (error !== null || gh === 'not-installed' || gh === 'signed-out') {
    return <Missing reference={reference} error={error} />
  }
  return <Loading />
}

export const REFERENCE_CARD_CLASS = 'flex w-[340px] flex-col gap-2.5 px-3.5 pt-3.5 pb-3.25'

/** A trigger of the app's own, such as a sidebar badge, that shows a reference's card on hover. */
export function ReferenceHoverCard({
  reference,
  trigger,
  side = 'bottom',
  align = 'start',
  sideOffset,
  anchor,
}: {
  reference: GitHubReference
  trigger: React.ReactElement
  side?: 'bottom' | 'right' | 'top'
  align?: 'start' | 'center'
  sideOffset?: number
  /** What the card lines up with, when not the trigger, such as the whole sidebar row. */
  anchor?: () => Element | null
}) {
  return (
    <HoverCard>
      <HoverCardTrigger render={trigger} delay={400} />
      <HoverCardContent
        side={side}
        align={align}
        sideOffset={sideOffset}
        anchor={anchor}
        className={REFERENCE_CARD_CLASS}
      >
        <ReferenceCard reference={reference} />
      </HoverCardContent>
    </HoverCard>
  )
}
