import type { ReactNode } from 'react'
import {
  Alert02Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  Copy01Icon,
  GitMergeIcon,
  LinkSquare02Icon,
  MagicWand01Icon,
  UserCheck01Icon,
} from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import { Trans, useTranslation } from 'react-i18next'
import type { CheckRun, GitStatus, GitTools, PullRequest } from '@shared/git'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { sessionLinkProps, useLinkSessionId } from '@renderer/features/session/open-link'
import { Glyph } from '@renderer/features/shell/glyph'
import { longAgo, shortDuration } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { CopyButton } from '../copy-button'
import { handOffText } from '../hand-off'
import { readyToMerge, waitingVariant } from '../next-step'
import { PILL, Segment } from '../pr-part'
import { PrIcon } from '../pr-icon'
import { BADGE, prStateText, REVIEW_BADGE, REVIEW_KEY } from '../pr-text'
import { LineCounts } from '../rows'
import { CreatePullRequest } from './create-pr-form'
import { ActionBtn, Note, PAGE_PAD } from './pane-ui'

/**
 * The branch's pull request with its checks, review and merge state; with none, the form that
 * opens one, or what the GitHub CLI still needs.
 */
export function PullRequestPage({
  status,
  pr,
  gh,
  panel,
  onHandOff,
}: {
  status: GitStatus
  pr: PullRequest | null
  gh: GitTools['gh']['state'] | null
  panel: string
  onHandOff: (text: string) => void
}) {
  const { t } = useTranslation('git')
  if (!status.remote?.github) {
    return (
      <div className={PAGE_PAD}>
        <Note icon={Alert02Icon}>{t('pane.pr.notGitHub')}</Note>
      </div>
    )
  }
  if (pr) return <PullRequestView status={status} pr={pr} onHandOff={onHandOff} />
  if (gh === null) return <Loading />
  if (gh === 'not-installed') {
    return (
      <div className={PAGE_PAD}>
        <Note icon={Alert02Icon} tone="warn">
          <Trans
            t={t}
            i18nKey="prPart.installGh"
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
        </Note>
      </div>
    )
  }
  if (gh === 'signed-out') {
    return (
      <div className={PAGE_PAD}>
        <Note
          icon={Alert02Icon}
          tone="warn"
          actions={<CopyButton text="gh auth login" label={t('prPart.copyCommand')} />}
        >
          {t('prPart.signInGh')} <code className="font-mono text-code-sm">gh auth login</code>
        </Note>
      </div>
    )
  }
  return <CreatePullRequest status={status} panel={panel} />
}

function Loading() {
  return (
    <div className="flex flex-col gap-2 px-1" aria-busy="true">
      <Skeleton className="h-5 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="mt-2 h-24 w-full" />
    </div>
  )
}

const ICON_TONE = {
  neutral: 'bg-subtle text-secondary',
  ok: 'bg-success/12 text-success',
  bad: 'bg-danger/11 text-danger',
  warn: 'bg-warning/13 text-warning',
  merged: 'bg-merged/12 text-merged',
} as const

/** One card of the page: a glyph on a tile of its tone, a name, and a pill saying where it stands. */
function Card({
  icon,
  tone,
  title,
  pill,
  children,
}: {
  icon: IconSvgElement
  tone: keyof typeof ICON_TONE
  title: string
  pill?: ReactNode
  children?: ReactNode
}) {
  return (
    <section className="rounded-xl bg-card shadow-outline">
      <div className="flex items-center gap-2.25 px-3 py-2.5 text-control">
        <span className={cn('grid size-5.5 place-items-center rounded-md', ICON_TONE[tone])}>
          <Glyph icon={icon} size={13} />
        </span>
        <b className="font-medium">{title}</b>
        <span className="flex-1" />
        {pill}
      </div>
      {children && <div className="px-3 pb-3">{children}</div>}
    </section>
  )
}

function PullRequestView({
  status,
  pr,
  onHandOff,
}: {
  status: GitStatus
  pr: PullRequest
  onHandOff: (text: string) => void
}) {
  const { t } = useTranslation('git')
  const sessionId = useLinkSessionId()
  const now = useNow()
  const done = pr.state === 'merged' || pr.state === 'closed'
  const when = done
    ? t(pr.state === 'merged' ? 'prPart.mergedAgo' : 'prPart.closedAgo', {
        when: longAgo(pr.mergedAt ?? pr.closedAt ?? pr.updatedAt, now),
      })
    : t('prCard.opened', { when: longAgo(pr.createdAt, now) })
  const fix = (): void => {
    const text = handOffText('handOffFix', status, pr, null, t)
    if (text) onHandOff(text)
  }
  return (
    <div className={cn(PAGE_PAD, 'flex flex-col gap-2.5')}>
      <header className="px-0.5 pb-1">
        <div className="flex items-start gap-2.25">
          <PrIcon state={pr.state} size={16} className="mt-0.75" />
          <h3 className="min-w-0 text-row leading-snug font-semibold [overflow-wrap:anywhere]">
            {pr.title} <span className="font-normal text-tertiary">#{pr.number}</span>
          </h3>
        </div>
        <div className="mt-2 ml-6.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-tertiary">
          <span className={cn(PILL, BADGE[pr.state])}>{prStateText(pr.state)}</span>
          {pr.author && <span>{pr.author.login}</span>}
          <span aria-hidden>·</span>
          <span>{when}</span>
          <span aria-hidden>·</span>
          <LineCounts insertions={pr.additions} deletions={pr.deletions} />
          <span>{t('timeline.files', { count: pr.changedFiles })}</span>
        </div>
        <div className="mt-2 ml-6.5 flex min-w-0 items-center gap-1.5 text-tertiary">
          <code className="min-w-0 truncate rounded-md bg-subtle px-1.5 py-px font-mono text-code-sm text-secondary">
            {pr.head}
          </code>
          <span aria-hidden>→</span>
          <code className="min-w-0 truncate rounded-md bg-subtle px-1.5 py-px font-mono text-code-sm text-secondary">
            {pr.base}
          </code>
        </div>
      </header>
      {!done && <ChecksCard pr={pr} onFix={fix} />}
      {!done && <ReviewCard pr={pr} />}
      <MergeCard pr={pr} />
      <div className="flex gap-1.5">
        <a
          {...sessionLinkProps(pr.url, sessionId)}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          <Glyph icon={LinkSquare02Icon} size={14} />
          {t('pr.openOnGitHub')}
        </a>
        <CopyLink url={pr.url} />
      </div>
    </div>
  )
}

function CopyLink({ url }: { url: string }) {
  const { t } = useTranslation('git')
  return (
    <Button variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(url)}>
      <Glyph icon={Copy01Icon} size={14} />
      {t('pane.pr.copyLink')}
    </Button>
  )
}

function ChecksCard({ pr, onFix }: { pr: PullRequest; onFix: () => void }) {
  const { t } = useTranslation('git')
  const sessionId = useLinkSessionId()
  const { checks } = pr
  const total = checks.passed + checks.failed + checks.pending
  if (total === 0) return null
  const failing = checks.runs.find((run) => run.outcome === 'failed')
  const tone = checks.state === 'failing' ? 'bad' : checks.state === 'pending' ? 'warn' : 'ok'
  const tally = [
    t('prPart.tally', { passed: checks.passed, total }),
    checks.failed > 0 && t('pr.checkCount.failed', { count: checks.failed }),
    checks.pending > 0 && t('pr.checkCount.pending', { count: checks.pending }),
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <Card
      icon={
        tone === 'bad' ? CancelCircleIcon : tone === 'warn' ? Clock01Icon : CheckmarkCircle02Icon
      }
      tone={tone}
      title={t('pane.pr.checks')}
      pill={
        <span className={cn(PILL, ICON_TONE[tone])}>
          {t(`pane.pr.checkState.${checks.state === 'none' ? 'passing' : checks.state}`)}
        </span>
      }
    >
      <div className="flex h-1.25 gap-0.5" aria-hidden>
        {checks.runs.map((run, i) => (
          <Segment key={`${i}:${run.name}`} run={run} />
        ))}
      </div>
      <p className="mt-2 text-small text-tertiary tabular">{tally}</p>
      <ul className="mt-1.5 flex flex-col">
        {checks.runs.map((run, i) => (
          <RunRow key={`${i}:${run.name}`} run={run} />
        ))}
      </ul>
      {failing && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-xl bg-danger-tint px-2.5 py-2 shadow-[inset_0_0_0_var(--hairline)_var(--danger-border)]">
          <span className="min-w-0 flex-1 text-control [overflow-wrap:anywhere]">
            <span className="font-medium">{failing.name}</span> {t('prPart.failedWord')}
          </span>
          {failing.url && (
            <a
              {...sessionLinkProps(failing.url, sessionId)}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              <Glyph icon={LinkSquare02Icon} size={14} />
              {t('pane.pr.openLog')}
            </a>
          )}
          <ActionBtn
            primary
            icon={MagicWand01Icon}
            label={t('next.action.handOffFix')}
            onClick={onFix}
          />
        </div>
      )}
    </Card>
  )
}

function RunRow({ run }: { run: CheckRun }) {
  const sessionId = useLinkSessionId()
  const lasted =
    run.startedAt !== null && run.completedAt !== null
      ? shortDuration(run.completedAt - run.startedAt)
      : null
  const name = <span className="min-w-0 flex-1 truncate">{run.name}</span>
  return (
    <li
      className={cn(
        'flex h-7 items-center gap-2 text-control',
        run.outcome === 'failed' && 'text-danger',
      )}
    >
      {run.outcome === 'pending' ? (
        <Spinner className="size-3.5 shrink-0 text-info" />
      ) : (
        <Glyph
          icon={run.outcome === 'failed' ? CancelCircleIcon : CheckmarkCircle02Icon}
          size={14}
          className={cn('shrink-0', run.outcome === 'failed' ? 'text-danger' : 'text-success')}
        />
      )}
      {run.url ? (
        <a
          {...sessionLinkProps(run.url, sessionId)}
          className="flex min-w-0 flex-1 items-center rounded-sm outline-none hover:underline focus-visible:focus-ring"
        >
          {name}
        </a>
      ) : (
        name
      )}
      {lasted && <span className="shrink-0 text-caption text-tertiary tabular">{lasted}</span>}
      {run.url && <Glyph icon={LinkSquare02Icon} size={12} className="shrink-0 text-placeholder" />}
    </li>
  )
}

function ReviewCard({ pr }: { pr: PullRequest }) {
  const { t } = useTranslation('git')
  if (!pr.review) return null
  return (
    <Card
      icon={UserCheck01Icon}
      tone={pr.review === 'approved' ? 'ok' : pr.review === 'changes_requested' ? 'bad' : 'warn'}
      title={t('pane.pr.review.title')}
      pill={<span className={cn(PILL, REVIEW_BADGE[pr.review])}>{t(REVIEW_KEY[pr.review])}</span>}
    >
      <p className="text-small text-tertiary">{t(`pane.pr.review.${pr.review}`)}</p>
    </Card>
  )
}

function MergeCard({ pr }: { pr: PullRequest }) {
  const { t } = useTranslation('git')
  const now = useNow()
  if (pr.state === 'merged') {
    return (
      <Card
        icon={GitMergeIcon}
        tone="merged"
        title={t('next.merged.title', { base: pr.base })}
        pill={<span className={cn(PILL, BADGE.merged)}>{prStateText('merged')}</span>}
      >
        <p className="text-small text-tertiary">
          {t('prPart.mergedAgo', { when: longAgo(pr.mergedAt ?? pr.updatedAt, now) })}
        </p>
      </Card>
    )
  }
  if (pr.state === 'closed') {
    return (
      <Card
        icon={GitMergeIcon}
        tone="neutral"
        title={t('next.closed.title')}
        pill={<span className={cn(PILL, BADGE.closed)}>{prStateText('closed')}</span>}
      >
        <p className="text-small text-tertiary">{t('next.closed.note')}</p>
      </Card>
    )
  }
  if (readyToMerge(pr)) {
    return (
      <Card
        icon={GitMergeIcon}
        tone="ok"
        title={t('next.merge.title')}
        pill={<span className={cn(PILL, BADGE.open)}>{t('pane.pr.mergeReady')}</span>}
      >
        <p className="text-small text-tertiary">{t('next.merge.clean', { base: pr.base })}</p>
      </Card>
    )
  }
  const variant = waitingVariant(pr)
  return (
    <Card
      icon={GitMergeIcon}
      tone="warn"
      title={t(`next.waiting.${variant}.title`, { base: pr.base })}
      pill={<span className={cn(PILL, REVIEW_BADGE.review_required)}>{t('pane.pr.blocked')}</span>}
    >
      <p className="text-small text-tertiary">{t(`next.waiting.${variant}.note`)}</p>
    </Card>
  )
}
