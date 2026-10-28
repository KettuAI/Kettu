import { useEffect, useRef, useState } from 'react'
import { RotateCwIcon } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { GITHUB_PULL_REQUEST_URL, type PullRequest, type PullRequestAuthor } from '@shared/git'
import { Avatar, AvatarFallback, AvatarImage } from '@renderer/components/ui/avatar'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { longAgo } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { loadAvatar, loadPullRequest, retryPullRequest, useGitStore } from '@renderer/stores/git'
import { CopyButton } from './copy-button'
import { authorLabel } from './pr-author'
import { ChecksIcon, PrIcon, ReviewIcon } from './pr-icon'
import { checkCountText, prStateText, REVIEW_KEY } from './pr-text'

interface PullRequestName {
  url: string
  owner: string
  repo: string
  number: string
}

function Author({ author, createdAt }: { author: PullRequestAuthor; createdAt: number }) {
  const { t } = useTranslation('git')
  const now = useNow()
  const picture = useGitStore((s) => s.avatars[author.login])
  const { name, login, initial } = authorLabel(author)
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Avatar aria-hidden className="size-5 after:border-subtle">
        {picture && <AvatarImage src={picture} alt="" />}
        <AvatarFallback className="bg-subtle text-meta leading-none font-medium text-secondary">
          {initial}
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 truncate text-small font-medium">{name}</span>
      {login && <span className="min-w-0 truncate text-xs text-tertiary">{login}</span>}
      {author.bot && (
        <Badge variant="outline" className="h-4 rounded-sm px-1.25 py-0 text-tertiary">
          {t('prCard.bot')}
        </Badge>
      )}
      {createdAt > 0 && (
        <span className="shrink-0 text-xs whitespace-nowrap text-tertiary tabular">
          · {t('prCard.opened', { when: longAgo(createdAt, now) })}
        </span>
      )}
    </div>
  )
}

function Facts({ pr }: { pr: PullRequest }) {
  const { t } = useTranslation('git')
  const now = useNow()
  const { checks, review } = pr
  const ended = pr.state === 'merged' ? pr.mergedAt : pr.state === 'closed' ? pr.closedAt : null
  const live = pr.state === 'open' || pr.state === 'draft'
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-xs text-secondary tabular">
      <span className="font-medium">{prStateText(pr.state)}</span>
      {live && checks.state !== 'none' && (
        <span className="inline-flex items-center gap-1">
          <ChecksIcon state={checks.state} size={12} />
          {checkCountText(checks)}
        </span>
      )}
      {live && review && (
        <span className="inline-flex items-center gap-1">
          <ReviewIcon review={review} size={12} />
          {t(REVIEW_KEY[review])}
        </span>
      )}
      {ended !== null && <span className="text-tertiary">{longAgo(ended, now)}</span>}
    </div>
  )
}

function Details({ pr }: { pr: PullRequest }) {
  return (
    <>
      {pr.author && <Author author={pr.author} createdAt={pr.createdAt} />}
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        title={pr.title}
        className="group/title flex items-start gap-2 rounded-md text-primary no-underline focus-ring"
      >
        <PrIcon state={pr.state} size={16} className="mt-0.75" />
        <span className="line-clamp-3 min-w-0 font-heading text-subheading font-semibold underline-offset-2 group-hover/title:underline">
          {pr.title}
        </span>
      </a>
      <div className="-mt-1.5 pl-6 text-xs text-tertiary">
        {pr.owner}/{pr.repo} #{pr.number} ·{' '}
        <span className="font-mono text-meta wrap-anywhere">{pr.head}</span> →{' '}
        <span className="font-mono text-meta wrap-anywhere">{pr.base}</span>
      </div>
      <Facts pr={pr} />
    </>
  )
}

function Loading() {
  return (
    <>
      <div className="flex items-center gap-2">
        <Skeleton className="size-5 rounded-full" />
        <Skeleton className="h-2.5 w-33" />
      </div>
      <div className="flex items-start gap-2">
        <Skeleton className="mt-0.75 size-4 rounded-full" />
        <div className="flex flex-1 flex-col gap-1.75 pt-1">
          <Skeleton className="h-3.25 w-[94%]" />
          <Skeleton className="h-3.25 w-[56%]" />
        </div>
      </div>
      <Skeleton className="-mt-0.5 ml-6 h-2.5 w-[70%]" />
      <Skeleton className="ml-6 h-2.5 w-[52%]" />
    </>
  )
}

function InstallGh() {
  const { t } = useTranslation('git')
  return (
    <p className="text-small text-secondary">
      <Trans
        t={t}
        i18nKey="prCard.installGh"
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
  )
}

function SignInGh() {
  const { t } = useTranslation('git')
  return (
    <div className="flex flex-col items-start gap-2 text-small text-secondary">
      <p>{t('prCard.signInGh')}</p>
      <span className="inline-flex items-center gap-1">
        <code className="rounded-sm bg-code-inline px-1.5 py-0.5 font-mono text-meta text-primary">
          gh auth login
        </code>
        <CopyButton text="gh auth login" label={t('prPart.copyCommand')} />
      </span>
    </div>
  )
}

function LoadFailed({ url, error }: { url: string; error: string | null }) {
  const { t } = useTranslation('git')
  const [retrying, setRetrying] = useState(false)
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-small text-secondary">{t('prCard.failed')}</p>
      {error && <p className="font-mono text-meta text-tertiary wrap-anywhere">{error}</p>}
      <Button
        variant="outline"
        size="xs"
        disabled={retrying}
        onClick={() => {
          setRetrying(true)
          void retryPullRequest(url).finally(() => setRetrying(false))
        }}
      >
        {retrying ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <RotateCwIcon data-icon="inline-start" />
        )}
        {t('prCard.retry')}
      </Button>
    </div>
  )
}

/** The card without details: gh is missing or signed out, or the load failed. */
function Missing({ name, error }: { name: PullRequestName; error: string | null }) {
  const gh = useGitStore((s) => s.tools?.gh.state ?? null)
  return (
    <>
      <div className="flex items-start gap-2">
        <PrIcon state={null} size={16} className="mt-0.5" />
        <span className="min-w-0 text-control wrap-anywhere">
          {name.owner}/{name.repo}#{name.number}
        </span>
      </div>
      <div className="-mt-1 pl-6">
        {gh === 'not-installed' ? (
          <InstallGh />
        ) : gh === 'signed-out' ? (
          <SignInGh />
        ) : (
          <LoadFailed url={name.url} error={error} />
        )}
      </div>
    </>
  )
}

function Card({ name }: { name: PullRequestName }) {
  const pr = useGitStore((s) => s.pullRequests[name.url])
  const error = useGitStore((s) => s.pullRequestErrors[name.url] ?? null)
  const gh = useGitStore((s) => s.tools?.gh.state ?? null)
  if (pr) return <Details pr={pr} />
  if (error !== null || gh === 'not-installed' || gh === 'signed-out') {
    return <Missing name={name} error={error} />
  }
  return <Loading />
}

/**
 * A pull request link as a chip: neutral, with only the state icon in color. Details load the
 * first time the chip scrolls into view, and its author's avatar once they arrive; without gh it
 * still opens the link.
 */
export function PrChip({ url, className }: { url: string; className?: string }) {
  const match = GITHUB_PULL_REQUEST_URL.exec(url)
  const pr = useGitStore((s) => s.pullRequests[url])
  const ref = useRef<HTMLAnchorElement>(null)
  const [seen, setSeen] = useState(false)
  const login = pr?.author?.login

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

  useEffect(() => {
    if (login) loadAvatar(login)
  }, [login])

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
        'inline-flex h-5 max-w-full items-center gap-1.5 rounded-md bg-subtle pr-2 pl-1.5 text-control leading-none text-primary no-underline shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)] transition-colors duration-(--duration-fast) hover:bg-hover hover:shadow-[inset_0_0_0_var(--hairline)_var(--border-default)]',
        className,
      )}
    >
      <PrIcon state={pr?.state ?? null} size={14} />
      <span className="self-baseline leading-5 whitespace-nowrap">
        {owner}/{repo}#{number}
      </span>
      {title && <span className="min-w-0 truncate text-tertiary">{title}</span>}
      {pr && <ChecksIcon state={pr.checks.state} size={12} />}
    </a>
  )

  return (
    <HoverCard>
      <HoverCardTrigger render={chip} delay={400} />
      <HoverCardContent className="flex w-[340px] flex-col gap-2.5 px-3.5 pt-3.5 pb-3.25">
        <Card name={{ url, owner: owner!, repo: repo!, number: number! }} />
      </HoverCardContent>
    </HoverCard>
  )
}
