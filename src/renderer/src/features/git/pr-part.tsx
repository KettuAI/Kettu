import { useState, type ReactNode } from 'react'
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  ExternalLinkIcon,
  GitPullRequestIcon,
  LockIcon,
  UserRoundCheckIcon,
  UserRoundIcon,
  UserRoundXIcon,
} from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import type { CheckRun, GitStatus, PullRequest } from '@shared/git'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { duration, longAgo } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { openGitDialog, useGitStore } from '@renderer/stores/git'
import { CopyButton } from './copy-button'
import { ChecksIcon, PrIcon } from './pr-icon'
import { prStateText } from './pr-text'
import { pullRequestHead, pushTargetOf } from './sync'
import { disclosureKeys, kidKeys } from './popover-keys'
import { Chevron, KID, Kids, Part, ROW } from './timeline'

const REVIEW = {
  approved: { Icon: UserRoundCheckIcon, color: 'text-success', key: 'pr.review.approved' },
  changes_requested: {
    Icon: UserRoundXIcon,
    color: 'text-danger',
    key: 'pr.review.changesRequested',
  },
  review_required: { Icon: UserRoundIcon, color: 'text-icon', key: 'pr.review.reviewRequired' },
} as const

/** The leading column of the part's rows, where a row's icon sits on the lane's line. */
function Lead({ children }: { children: ReactNode }) {
  return <span className="flex w-4 shrink-0 justify-center">{children}</span>
}

/** The branch's pull request, or how to get one; only for a GitHub remote. */
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
  if (pr) {
    return (
      <Part>
        <PullRequestDetails pr={pr} onOpen={onClose} />
      </Part>
    )
  }

  const branch = status.head.branch
  const head = pullRequestHead(status)
  const target = pushTargetOf(status)
  const compare =
    head !== null &&
    status.defaultBranch !== null &&
    `https://github.com/${github.owner}/${github.repo}/compare/${encodeURIComponent(status.defaultBranch)}...${head.split(':').map(encodeURIComponent).join(':')}?expand=1`

  if (gh === 'not-installed') {
    return (
      <Line>
        <span className="min-w-0 flex-1">
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
        </span>
        {compare && (
          <a
            href={compare}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: 'outline', size: 'xs' })}
          >
            {t('pr.openOnGitHub')}
          </a>
        )}
      </Line>
    )
  }
  if (gh === 'signed-out') {
    return (
      <Line>
        <span className="min-w-0 flex-1">{t('prPart.signInGh')}</span>
        <code className="rounded-sm bg-code-inline px-1.5 py-0.5 font-mono text-meta text-primary">
          gh auth login
        </code>
        <CopyButton text="gh auth login" label={t('prPart.copyCommand')} />
      </Line>
    )
  }
  if (!target || target.setUpstream) {
    if (status.head.detached || !branch || !target) return null
    return (
      <Line>
        <span className="min-w-0 flex-1">{t('prPart.publishFirst')}</span>
      </Line>
    )
  }
  if (head === null) return null
  return (
    <Line>
      <span className="min-w-0 flex-1 truncate">{t('prPart.none')}</span>
      <Button
        variant="outline"
        size="xs"
        data-git-row=""
        onClick={() => {
          onClose()
          openGitDialog(status.projectPath, { kind: 'createPr' })
        }}
      >
        {t('prPart.create')}
      </Button>
    </Line>
  )
}

/** The part when there is no pull request to show: why, and what to do about it. */
function Line({ children }: { children: ReactNode }) {
  return (
    <Part>
      <div className="shrink-0 p-1.5">
        <div className="flex min-h-10 items-center gap-2 py-1 pr-1.5 pl-2 text-small text-secondary">
          <Lead>
            <GitPullRequestIcon aria-hidden className="size-4 text-icon" />
          </Lead>
          {children}
        </div>
      </div>
    </Part>
  )
}

function PullRequestDetails({ pr, onOpen }: { pr: PullRequest; onOpen: () => void }) {
  const { t } = useTranslation('git')
  const now = useNow()
  const [checksOpen, setChecksOpen] = useState(false)
  const toggleChecks = (): void => setChecksOpen((open) => !open)
  const done = pr.state === 'merged' || pr.state === 'closed'
  const { checks } = pr
  const blocked = done ? null : blockReason(pr)
  return (
    <div className="shrink-0 p-1.5">
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        tabIndex={-1}
        data-git-row=""
        className="group/pr grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2 gap-y-0.75 rounded-md px-2 pt-2 pb-2.25 text-left text-small outline-none transition-colors duration-(--duration-fast) focus:bg-hover"
        title={pr.title}
        onClick={onOpen}
      >
        <PrIcon state={pr.state} size={16} className="mt-0.75" />
        <span className="line-clamp-2 font-heading text-subheading font-semibold">{pr.title}</span>
        <span className="mt-0.75 inline-flex items-center gap-0.5 text-xs text-tertiary tabular group-focus/pr:text-primary">
          #{pr.number}
          <ExternalLinkIcon aria-hidden className="size-3" />
        </span>
        <span className="col-span-2 col-start-2 text-xs text-tertiary">
          <Trans
            t={t}
            i18nKey="prPart.meta"
            values={{ state: prStateText(pr.state), when: longAgo(pr.updatedAt, now) }}
            components={{
              state: <span className="font-medium text-secondary" />,
              nw: <span className="whitespace-nowrap" />,
              head: <span className="font-mono text-meta">{pr.head}</span>,
              base: <span className="font-mono text-meta">{pr.base}</span>,
            }}
          />
        </span>
      </a>
      {!done && checks.state !== 'none' && (
        <>
          <button
            type="button"
            tabIndex={-1}
            data-git-row=""
            className={ROW}
            aria-expanded={checksOpen}
            onClick={toggleChecks}
            onKeyDown={disclosureKeys(checksOpen, toggleChecks)}
          >
            <Lead>
              <ChecksIcon state={checks.state} size={14} />
            </Lead>
            <span className="min-w-0 flex-1 truncate tabular">
              {[
                checks.passed > 0 && t('pr.checkCount.passed', { count: checks.passed }),
                checks.pending > 0 && t('pr.checkCount.pending', { count: checks.pending }),
                checks.failed > 0 && t('pr.checkCount.failed', { count: checks.failed }),
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
            <Chevron open={checksOpen} />
          </button>
          {checksOpen && (
            <Kids>
              {/* Two workflows can name a job alike; the list is whole each time, so its order is the key. */}
              {checks.runs.map((run, i) => (
                <CheckRow key={`${i}:${run.name}`} run={run} now={now} />
              ))}
            </Kids>
          )}
        </>
      )}
      {!done && pr.review && <ReviewRow review={pr.review} />}
      {blocked && (
        <div
          className={cn(
            'flex min-h-6.5 items-center gap-2 px-2 pb-0.75 text-xs',
            blocked === 'prPart.blocked.conflicts' ? 'text-danger' : 'text-tertiary',
          )}
        >
          <Lead>
            <LockIcon aria-hidden className="size-3" />
          </Lead>
          <span className="min-w-0 flex-1 truncate" title={t(blocked, { base: pr.base })}>
            {t(blocked, { base: pr.base })}
          </span>
        </div>
      )}
    </div>
  )
}

/** A check's state; one that has not started yet is drawn apart from one running. */
function CheckRunIcon({ run }: { run: CheckRun }) {
  const { t } = useTranslation('git')
  if (run.outcome === 'passed') {
    return (
      <CircleCheckIcon
        role="img"
        aria-label={t('prPart.run.passed')}
        className="size-3 shrink-0 text-success"
      />
    )
  }
  if (run.outcome === 'failed') {
    return (
      <CircleXIcon
        role="img"
        aria-label={t('prPart.run.failed')}
        className="size-3 shrink-0 text-danger"
      />
    )
  }
  if (run.startedAt === null) {
    return <CircleDashedIcon aria-hidden className="size-3 shrink-0 text-icon" />
  }
  return (
    <Spinner
      role="img"
      aria-label={t('prPart.run.running')}
      className="size-3 shrink-0 text-info"
    />
  )
}

function CheckRow({ run, now }: { run: CheckRun; now: number }) {
  const { t } = useTranslation('git')
  const took =
    run.outcome === 'pending'
      ? run.startedAt
        ? duration(now - run.startedAt)
        : t('prPart.queued')
      : run.startedAt && run.completedAt
        ? duration(run.completedAt - run.startedAt)
        : null
  const body = (
    <>
      <CheckRunIcon run={run} />
      <span className="min-w-0 flex-1 truncate text-primary">{run.name}</span>
      {took && <span className="shrink-0 text-xs text-tertiary tabular">{took}</span>}
    </>
  )
  if (!run.url) {
    return <div className="flex h-7 min-w-0 items-center gap-2 pr-2 pl-8 text-small">{body}</div>
  }
  return (
    <a
      href={run.url}
      target="_blank"
      rel="noreferrer"
      tabIndex={-1}
      data-git-row=""
      className={cn(KID, 'pl-8')}
      title={run.name}
      onKeyDown={kidKeys}
    >
      {body}
    </a>
  )
}

function ReviewRow({ review }: { review: NonNullable<PullRequest['review']> }) {
  const { t } = useTranslation('git')
  const { Icon, color, key } = REVIEW[review]
  return (
    <div className="flex h-row items-center gap-2 px-2 text-small">
      <Lead>
        <Icon aria-hidden className={cn('size-3.5', color)} />
      </Lead>
      <span className="min-w-0 flex-1 truncate">{t(key)}</span>
    </div>
  )
}

type BlockKey =
  | 'prPart.blocked.draft'
  | 'prPart.blocked.conflicts'
  | 'prPart.blocked.checks'
  | 'prPart.blocked.review'
  | 'prPart.blocked.rules'

/** Why an open pull request cannot merge yet, or null when nothing is known to stop it. */
function blockReason(pr: PullRequest): BlockKey | null {
  if (pr.state === 'draft') return 'prPart.blocked.draft'
  if (pr.mergeable === 'conflicting') return 'prPart.blocked.conflicts'
  if (pr.mergeable !== 'blocked') return null
  if (pr.checks.state === 'failing' || pr.checks.state === 'pending') return 'prPart.blocked.checks'
  if (pr.review === 'changes_requested' || pr.review === 'review_required')
    return 'prPart.blocked.review'
  return 'prPart.blocked.rules'
}
