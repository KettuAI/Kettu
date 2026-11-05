import type { ReactNode } from 'react'
import { CheckIcon, CircleDashedIcon, ExternalLinkIcon, XIcon } from 'lucide-react'
import type { TFunction } from 'i18next'
import { Trans, useTranslation } from 'react-i18next'
import type { CheckRun, GitStatus, PullRequest, PullRequestState } from '@shared/git'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { longAgo, shortDuration } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { openGitDialog, useGitStore } from '@renderer/stores/git'
import { CopyButton } from './copy-button'
import { PrIcon } from './pr-icon'
import { prStateText, REVIEW_KEY } from './pr-text'
import { PartHead, PartRule, ROW } from './rows'
import { pullRequestHead, pushTargetOf } from './sync'

/** The branch's pull request with its checks, or how to get one; only for a GitHub remote. */
export function PullRequestPart({
  status,
  pr,
  onClose,
}: {
  status: GitStatus
  pr: PullRequest | null
  onClose: () => void
}) {
  const { t } = useTranslation('git')
  const gh = useGitStore((s) => s.tools?.gh.state ?? null)
  const github = status.remote?.github
  if (!github) return null
  if (pr) return <PullRequestDetails pr={pr} onOpen={onClose} />

  const branch = status.head.branch
  const head = pullRequestHead(status)
  const target = pushTargetOf(status)
  const compare =
    head !== null &&
    status.defaultBranch !== null &&
    `https://github.com/${github.owner}/${github.repo}/compare/${encodeURIComponent(status.defaultBranch)}...${head.split(':').map(encodeURIComponent).join(':')}?expand=1`

  if (gh === 'not-installed') {
    return (
      <Line
        action={
          compare && (
            <a
              href={compare}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: 'outline', size: 'sm', className: 'text-hint' })}
            >
              {t('pr.openOnGitHub')}
            </a>
          )
        }
      >
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
      </Line>
    )
  }
  if (gh === 'signed-out') {
    return (
      <Line
        action={
          <span className="inline-flex items-center gap-1">
            <code className="rounded-sm bg-code-inline px-1.5 py-0.5 font-mono text-code-sm text-code-inline">
              gh auth login
            </code>
            <CopyButton text="gh auth login" label={t('prPart.copyCommand')} />
          </span>
        }
      >
        {t('prPart.signInGh')}
      </Line>
    )
  }
  if (!target || target.setUpstream) {
    if (status.head.detached || !branch || !target) return null
    return <Line>{t('prPart.publishFirst')}</Line>
  }
  if (head === null) return null
  return (
    <Line
      action={
        <Button
          variant="outline"
          size="sm"
          data-git-row=""
          className="px-2.5 text-hint"
          onClick={() => {
            onClose()
            openGitDialog(status.projectPath, { kind: 'createPr' })
          }}
        >
          {t('prPart.create')}
        </Button>
      }
    >
      {t('prPart.none')}
    </Line>
  )
}

/** The part when there is no pull request to show: why, and what to do about it. */
function Line({ children, action }: { children: ReactNode; action?: ReactNode }) {
  const { t } = useTranslation('git')
  return (
    <>
      <PartRule />
      <PartHead>
        <span className="font-medium">{t('prPart.label')}</span>
      </PartHead>
      <div className="flex min-h-7 items-center gap-2 text-hint text-secondary">
        <span className="min-w-0 flex-1">{children}</span>
        {action}
      </div>
    </>
  )
}

const BADGE: Record<PullRequestState, string> = {
  open: 'bg-success/10 text-success',
  draft: 'bg-subtle text-secondary',
  merged: 'bg-merged/10 text-merged',
  closed: 'bg-danger/10 text-danger',
}

function PullRequestDetails({ pr, onOpen }: { pr: PullRequest; onOpen: () => void }) {
  const { t } = useTranslation('git')
  const now = useNow()
  const done = pr.state === 'merged' || pr.state === 'closed'
  const { checks } = pr
  const total = checks.passed + checks.failed + checks.pending
  const note = done
    ? t(pr.state === 'merged' ? 'prPart.mergedAgo' : 'prPart.closedAgo', {
        when: longAgo(pr.mergedAt ?? pr.closedAt ?? pr.updatedAt, now),
      })
    : waitingFor(pr, t)
  return (
    <>
      <PartRule />
      <PartHead>
        <span className="font-medium">{t('prPart.label')}</span>
        <span className="flex-1" />
        <span
          className={cn(
            'inline-flex h-4.5 items-center gap-1.25 rounded-lg px-1.5 text-code-sm font-semibold',
            BADGE[pr.state],
          )}
        >
          <PrIcon state={pr.state} size={12} className="size-2.75 text-current" />
          {prStateText(pr.state)}
        </span>
      </PartHead>
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        tabIndex={-1}
        data-git-row=""
        title={pr.title}
        onClick={onOpen}
        className={cn(ROW, 'mt-0.5 py-0.5 text-control font-medium tracking-[-0.004em]')}
      >
        <span className="line-clamp-2">
          <span className="font-normal text-tertiary tabular">#{pr.number}</span>
          {'  '}
          {pr.title}
        </span>
      </a>
      {total > 0 && (
        <>
          <div className="mt-2.5 flex items-center gap-2.5">
            <div className="flex flex-1 gap-0.75" aria-hidden>
              {checks.runs.map((run, i) => (
                <span
                  key={`${i}:${run.name}`}
                  className={cn('h-1 flex-1 rounded-sm', SEGMENT[run.outcome])}
                />
              ))}
            </div>
            <span className="shrink-0 text-small text-tertiary tabular">
              {t('prPart.checksPassed', { passed: checks.passed, count: total })}
            </span>
          </div>
          <div className="mt-1.5">
            {/* Two workflows can name a job alike; the list is whole each time, so its order is the key. */}
            {checks.runs.map((run, i) => (
              <CheckRow key={`${i}:${run.name}`} run={run} now={now} />
            ))}
          </div>
        </>
      )}
      <div className="mt-2.5 flex items-center gap-1.5">
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          data-git-row=""
          tabIndex={-1}
          onClick={onOpen}
          className={buttonVariants({ variant: 'outline', size: 'sm', className: 'text-hint' })}
        >
          <ExternalLinkIcon />
          {t('pr.openOnGitHub')}
        </a>
        <span className="flex-1" />
        {note && (
          <span
            className={cn(
              'min-w-0 truncate text-small',
              pr.mergeable === 'conflicting' && !done ? 'text-danger' : 'text-tertiary',
            )}
            title={note}
          >
            {note}
          </span>
        )}
      </div>
    </>
  )
}

const SEGMENT = {
  passed: 'bg-success',
  failed: 'bg-danger',
  pending: 'bg-border',
} as const

/** What an open pull request waits for, in the fewest words, or null when nothing is known. */
function waitingFor(pr: PullRequest, t: TFunction<'git'>): string | null {
  if (pr.state === 'draft') return t('prPart.waiting.draft')
  if (pr.mergeable === 'conflicting') return t('prPart.blocked.conflicts', { base: pr.base })
  if (pr.checks.state === 'failing') return t('prPart.waiting.failing')
  if (pr.review === 'review_required') return t('prPart.waiting.review')
  if (pr.review) return t(REVIEW_KEY[pr.review])
  if (pr.checks.state === 'pending') return t('prPart.waiting.checks')
  return pr.mergeable === 'clean' ? t('prPart.waiting.ready') : null
}

/** A check's state; one that has not started yet is drawn apart from one running. */
function CheckRunIcon({ run }: { run: CheckRun }) {
  const { t } = useTranslation('git')
  if (run.outcome === 'passed') {
    return (
      <CheckIcon
        role="img"
        aria-label={t('prPart.run.passed')}
        strokeWidth={2}
        className="size-3 text-success"
      />
    )
  }
  if (run.outcome === 'failed') {
    return (
      <XIcon
        role="img"
        aria-label={t('prPart.run.failed')}
        strokeWidth={2}
        className="size-3 text-danger"
      />
    )
  }
  if (run.startedAt === null) {
    return (
      <CircleDashedIcon
        role="img"
        aria-label={t('prPart.queued')}
        className="size-3 text-tertiary"
      />
    )
  }
  return (
    <Spinner role="img" aria-label={t('prPart.run.running')} className="size-3 text-tertiary" />
  )
}

function CheckRow({ run, now }: { run: CheckRun; now: number }) {
  const { t } = useTranslation('git')
  const took =
    run.outcome === 'pending'
      ? run.startedAt
        ? shortDuration(now - run.startedAt)
        : t('prPart.queued')
      : run.startedAt && run.completedAt
        ? shortDuration(run.completedAt - run.startedAt)
        : null
  const body = (
    <>
      <span className="flex w-3.25 shrink-0 justify-center">
        <CheckRunIcon run={run} />
      </span>
      <span className="min-w-0 flex-1 truncate text-secondary">{run.name}</span>
      {took && <span className="shrink-0 text-tertiary tabular">{took}</span>}
    </>
  )
  if (!run.url) {
    return <div className="flex h-6 min-w-0 items-center gap-2.25 text-hint">{body}</div>
  }
  return (
    <a
      href={run.url}
      target="_blank"
      rel="noreferrer"
      tabIndex={-1}
      data-git-row=""
      className={cn(ROW, 'h-6 gap-2.25 text-hint')}
      title={run.name}
    >
      {body}
    </a>
  )
}
