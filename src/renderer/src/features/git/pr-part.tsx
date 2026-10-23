import { useState } from 'react'
import {
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleSlashIcon,
  ExternalLinkIcon,
  GitPullRequestCreateArrowIcon,
} from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import type { CheckRun, GitStatus, PullRequest } from '@shared/git'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { duration, longAgo } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { openGitDialog, useGitStore } from '@renderer/stores/git'
import { CopyButton } from './copy-button'
import { ChecksIcon, PrIcon } from './pr-icon'
import { prStateText } from './pr-text'
import { pullRequestHead, pushTargetOf } from './sync'
import { Part, ROW } from './timeline'

const STATE_COLOR = {
  open: 'text-success-text',
  draft: 'text-muted-foreground',
  merged: 'text-merged',
  closed: 'text-destructive',
} as const

const RUN_STATE = { passed: 'passing', failed: 'failing', pending: 'pending' } as const

const REVIEW = {
  approved: { Icon: CircleCheckIcon, color: 'text-success', key: 'pr.review.approved' },
  changes_requested: {
    Icon: CircleAlertIcon,
    color: 'text-destructive',
    key: 'pr.review.changesRequested',
  },
  review_required: {
    Icon: CircleDotIcon,
    color: 'text-attention',
    key: 'pr.review.reviewRequired',
  },
} as const

/** Text aligned with a row's label, past its 16 px icon. */
const UNDER = 'pr-2 pl-8 text-xs text-muted-foreground'

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
  if (pr)
    return (
      <Part>
        <PullRequestDetails pr={pr} />
      </Part>
    )

  const branch = status.head.branch
  const head = pullRequestHead(status)
  const target = pushTargetOf(status)
  const compare =
    head !== null &&
    status.defaultBranch !== null &&
    `https://github.com/${github.owner}/${github.repo}/compare/${encodeURIComponent(status.defaultBranch)}...${head.split(':').map(encodeURIComponent).join(':')}?expand=1`

  if (gh === 'not-installed') {
    return (
      <Part>
        <div className="flex items-center gap-2 py-2 pr-2 pl-3.5 text-xs text-muted-foreground">
          <span className="flex-1">
            <Trans
              t={t}
              i18nKey="prPart.installGh"
              components={{
                cli: (
                  <a
                    href="https://cli.github.com"
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-2 hover:text-foreground"
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
              className={buttonVariants({ variant: 'quiet', size: 'xs' })}
            >
              <ExternalLinkIcon data-icon="inline-start" />
              {t('pr.openOnGitHub')}
            </a>
          )}
        </div>
      </Part>
    )
  }
  if (gh === 'signed-out') {
    return (
      <Part>
        <div className="flex items-center gap-2 py-2 pr-2 pl-3.5 text-xs text-muted-foreground">
          <span className="flex-1">{t('prPart.signInGh')}</span>
          <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-meta text-foreground">
            gh auth login
          </code>
          <CopyButton text="gh auth login" label={t('prPart.copyCommand')} />
        </div>
      </Part>
    )
  }
  if (!target || target.setUpstream) {
    if (status.head.detached || !branch || !target) return null
    return (
      <Part>
        <p className="px-3.5 py-2.5 text-xs text-muted-foreground">{t('prPart.publishFirst')}</p>
      </Part>
    )
  }
  if (head === null) return null
  return (
    <Part>
      <div className="flex items-center gap-2 py-1.5 pr-1.5 pl-3.5 text-xs text-muted-foreground">
        <span className="flex-1">{t('prPart.none')}</span>
        <Button
          variant="quiet"
          size="xs"
          onClick={() => {
            onClose()
            openGitDialog(status.projectPath, { kind: 'createPr' })
          }}
        >
          <GitPullRequestCreateArrowIcon data-icon="inline-start" />
          {t('prPart.create')}
        </Button>
      </div>
    </Part>
  )
}

function PullRequestDetails({ pr }: { pr: PullRequest }) {
  const { t } = useTranslation('git')
  const now = useNow()
  const [checksOpen, setChecksOpen] = useState(false)
  const done = pr.state === 'merged' || pr.state === 'closed'
  const { checks } = pr
  const blocked = done ? null : blockReason(pr)
  return (
    <div className="flex flex-col p-1.5">
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        data-git-row=""
        className={ROW}
        title={pr.title}
      >
        <PrIcon state={pr.state} size={16} />
        <span className="min-w-0 flex-1 truncate font-medium">{pr.title}</span>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">#{pr.number}</span>
        <ExternalLinkIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      </a>
      <div className={cn(UNDER, '-mt-1 pb-1.5 tabular')}>
        <Trans
          t={t}
          i18nKey="prPart.meta"
          values={{ state: prStateText(pr.state), when: longAgo(pr.updatedAt, now) }}
          components={{
            state: <span className={STATE_COLOR[pr.state]} />,
            head: <span className="font-mono text-meta">{pr.head}</span>,
            base: <span className="font-mono text-meta">{pr.base}</span>,
          }}
        />
      </div>
      {!done && checks.state !== 'none' && (
        <>
          <button
            type="button"
            data-git-row=""
            className={ROW}
            aria-expanded={checksOpen}
            onClick={() => setChecksOpen((open) => !open)}
            onKeyDown={(event) => {
              if (
                (event.key === 'ArrowRight' && !checksOpen) ||
                (event.key === 'ArrowLeft' && checksOpen)
              ) {
                event.preventDefault()
                setChecksOpen(!checksOpen)
              }
            }}
          >
            <span className="flex w-4 shrink-0 justify-center">
              <ChecksIcon state={checks.state} size={14} />
            </span>
            <span className="min-w-0 flex-1 truncate tabular">
              {[
                checks.passed > 0 && t('pr.checkCount.passed', { count: checks.passed }),
                checks.pending > 0 && t('pr.checkCount.pending', { count: checks.pending }),
                checks.failed > 0 && t('pr.checkCount.failed', { count: checks.failed }),
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
            <ChevronRightIcon
              aria-hidden
              className={cn(
                'size-3 shrink-0 text-muted-foreground transition-transform duration-(--duration-fast) motion-reduce:transition-none',
                checksOpen && 'rotate-90',
              )}
            />
          </button>
          {checksOpen &&
            // Two workflows can name a job alike; the list is whole each time, so its order is the key.
            checks.runs.map((run, i) => <CheckRow key={`${i}:${run.name}`} run={run} now={now} />)}
        </>
      )}
      {!done && pr.review && <ReviewRow review={pr.review} />}
      {blocked && (
        <div className="flex h-row items-center gap-2 px-2 text-muted-foreground">
          <CircleSlashIcon aria-hidden className="size-3.5 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-xs" title={t(blocked, { base: pr.base })}>
            {t(blocked, { base: pr.base })}
          </span>
        </div>
      )}
    </div>
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
      <span className="w-4 shrink-0" />
      <ChecksIcon state={RUN_STATE[run.outcome]} size={12} />
      <span className="min-w-0 flex-1 truncate text-xs">{run.name}</span>
      {took && <span className="shrink-0 text-xs text-muted-foreground tabular">{took}</span>}
    </>
  )
  if (!run.url) {
    return <div className="flex h-row items-center gap-2 px-2">{body}</div>
  }
  return (
    <a
      href={run.url}
      target="_blank"
      rel="noreferrer"
      data-git-row=""
      className={ROW}
      title={run.name}
    >
      {body}
    </a>
  )
}

function ReviewRow({ review }: { review: NonNullable<PullRequest['review']> }) {
  const { t } = useTranslation('git')
  const { Icon, color, key } = REVIEW[review]
  return (
    <div className="flex h-row items-center gap-2 px-2">
      <Icon aria-hidden className={cn('size-3.5 w-4 shrink-0', color)} />
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
