import type { ReactNode } from 'react'
import {
  Alert02Icon,
  Cancel01Icon,
  LinkSquare02Icon,
  MagicWand01Icon,
} from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
import type { CheckRun, GitStatus, PullRequest } from '@shared/git'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { sessionLinkProps, useLinkSessionId } from '@renderer/features/session/open-link'
import { Glyph } from '@renderer/features/shell/glyph'
import { longAgo, shortDuration } from '@renderer/lib/format'
import { hostOfPath } from '@renderer/lib/host-paths'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { ghStateOf, useGitStore } from '@renderer/stores/git'
import { CopyButton } from './copy-button'
import { PrIcon } from './pr-icon'
import { BADGE, prStateText, REVIEW_BADGE, REVIEW_KEY } from './pr-text'
import { compareUrl, nextStepOf } from './next-step'
import { PartHead } from './rows'

/**
 * The branch's pull request with its checks, or what GitHub's tool still needs to show one; only
 * for a GitHub remote. A branch with no pull request is the next-step card's to say.
 */
export function PullRequestPart({
  status,
  pr,
  onClose,
  onFix,
}: {
  status: GitStatus
  pr: PullRequest | null
  onClose: () => void
  /** Asks the agent to fix the pull request's failing checks. */
  onFix: () => void
}) {
  const { t } = useTranslation('git')
  const sessionId = useLinkSessionId()
  const gh = useGitStore((s) => ghStateOf(s, hostOfPath(status.projectPath)))
  if (!status.remote?.github) return null
  if (pr) return <PullRequestCard pr={pr} onOpen={onClose} onFix={onFix} />

  if (gh === 'not-installed') {
    // The next-step card already offers GitHub's page when it is the way to a pull request.
    const step = nextStepOf(status, null, gh)
    const offered = [step.primary, step.secondary].some((b) => b?.action === 'openCompare')
    const compare = offered ? null : compareUrl(status)
    return (
      <Note
        action={
          compare && (
            <a
              {...sessionLinkProps(compare, sessionId, { onOpen: onClose })}
              tabIndex={-1}
              data-git-row=""
              className={buttonVariants({
                variant: 'outline',
                size: 'xs',
                className: 'mt-2 text-hint',
              })}
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
      </Note>
    )
  }
  if (gh === 'signed-out') {
    return (
      <Note
        action={
          <div className="mt-2 flex items-center justify-between rounded-lg bg-code-inline py-0.5 pr-0.5 pl-2.5">
            <code className="font-mono text-code-sm text-code-inline">gh auth login</code>
            <CopyButton text="gh auth login" label={t('prPart.copyCommand')} />
          </div>
        }
      >
        {t('prPart.signInGh')}
      </Note>
    )
  }
  return null
}

/** The guidance in place of a pull request: what the GitHub CLI still needs. */
function Note({ children, action }: { children: ReactNode; action?: ReactNode }) {
  const { t } = useTranslation('git')
  return (
    <section className="mt-4">
      <PartHead>
        <span>{t('prPart.label')}</span>
      </PartHead>
      <div className="mt-1 flex items-start gap-2 rounded-xl bg-warning-tint px-2.75 py-2.25 text-small leading-normal text-secondary">
        <Glyph icon={Alert02Icon} size={14} className="mt-0.5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          {children}
          {action}
        </div>
      </div>
    </section>
  )
}

export const PILL =
  'inline-flex h-4.5 items-center gap-1 rounded-full px-1.75 text-caption font-medium'

function PullRequestCard({
  pr,
  onOpen,
  onFix,
}: {
  pr: PullRequest
  onOpen: () => void
  onFix: () => void
}) {
  const { t } = useTranslation('git')
  const sessionId = useLinkSessionId()
  const now = useNow()
  const done = pr.state === 'merged' || pr.state === 'closed'
  const { checks } = pr
  const total = checks.passed + checks.failed + checks.pending
  const failing = checks.runs.find((run) => run.outcome === 'failed')
  const when = done
    ? t(pr.state === 'merged' ? 'prPart.mergedAgo' : 'prPart.closedAgo', {
        when: longAgo(pr.mergedAt ?? pr.closedAt ?? pr.updatedAt, now),
      })
    : t('prCard.opened', { when: longAgo(pr.createdAt, now) })
  const tally = [
    t('prPart.tally', { passed: checks.passed, total }),
    checks.failed > 0 && t('pr.checkCount.failed', { count: checks.failed }),
    checks.pending > 0 && t('pr.checkCount.pending', { count: checks.pending }),
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <section className="mt-4">
      <PartHead>
        <span>{t('prPart.label')}</span>
        <span className="flex-1" />
        <a
          {...sessionLinkProps(pr.url, sessionId, { onOpen })}
          tabIndex={-1}
          data-git-row=""
          className="-mr-1.5 inline-flex h-5.5 items-center gap-1 rounded-md px-1.5 font-normal text-tertiary outline-none hover:text-primary focus:bg-hover"
        >
          {t('pr.openOnGitHub')}
          <Glyph icon={LinkSquare02Icon} size={12} />
        </a>
      </PartHead>
      <div className="mt-1 rounded-card bg-card p-3 shadow-card">
        <div className="flex items-center gap-1.75 text-small text-tertiary">
          <PrIcon state={pr.state} size={14} />
          <span className="font-medium text-secondary tabular">#{pr.number}</span>
          <span className={cn(PILL, BADGE[pr.state])}>{prStateText(pr.state)}</span>
          <span className="flex-1" />
          <span className="truncate">{when}</span>
        </div>
        <a
          {...sessionLinkProps(pr.url, sessionId, { onOpen })}
          tabIndex={-1}
          data-git-row=""
          title={pr.title}
          className="mt-1.75 block rounded-sm text-control leading-snug font-medium tracking-[-0.004em] outline-none hover:underline focus:underline"
        >
          <span className="line-clamp-2">{pr.title}</span>
        </a>
        {!done && total > 0 && (
          <>
            <div className="mt-3 flex h-1.25 gap-0.5" aria-hidden>
              {checks.runs.map((run, i) => (
                <Segment key={`${i}:${run.name}`} run={run} />
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2.5 text-small text-tertiary">
              <span className="min-w-0 truncate tabular">{tally}</span>
              <span className="flex-1" />
              {pr.review && (
                <span className={cn(PILL, 'shrink-0', REVIEW_BADGE[pr.review])}>
                  {t(REVIEW_KEY[pr.review])}
                </span>
              )}
            </div>
          </>
        )}
        {!done && failing && <FailingRow run={failing} onOpen={onOpen} onFix={onFix} />}
      </div>
    </section>
  )
}

/** One check in the bar: failed red, passed green, running with light moving over it, queued gray. */
export function Segment({ run }: { run: CheckRun }) {
  const running = run.outcome === 'pending' && run.startedAt !== null
  return (
    <span
      className={cn(
        'relative flex-1 overflow-hidden rounded-xs',
        run.outcome === 'failed' && 'bg-danger',
        run.outcome === 'passed' && 'bg-success',
        run.outcome === 'pending' && 'bg-border-strong',
      )}
    >
      {running && (
        <span className="absolute inset-0 motion-safe:animate-[sheen_1.6s_var(--ease-standard)_infinite]">
          <span className="block h-full w-2/5 rounded-xs bg-(--text-tertiary) opacity-60" />
        </span>
      )}
    </span>
  )
}

/** The first failing check, with what the agent can do about it. */
function FailingRow({
  run,
  onOpen,
  onFix,
}: {
  run: CheckRun
  onOpen: () => void
  onFix: () => void
}) {
  const { t } = useTranslation('git')
  const sessionId = useLinkSessionId()
  const name = <span className="font-medium">{run.name}</span>
  return (
    <div className="mt-2.5 flex items-center gap-1.75 rounded-xl bg-danger-tint py-1.25 pr-1.25 pl-2.5 text-control shadow-[inset_0_0_0_var(--hairline)_var(--danger-border)]">
      <Glyph icon={Cancel01Icon} size={14} className="shrink-0 text-danger" />
      <span className="min-w-0 truncate">
        {run.url ? (
          <a
            {...sessionLinkProps(run.url, sessionId, { onOpen })}
            tabIndex={-1}
            data-git-row=""
            className="rounded-sm outline-none hover:underline focus:underline"
          >
            {name}
          </a>
        ) : (
          name
        )}{' '}
        {t('prPart.failedWord')}
      </span>
      {run.startedAt !== null && run.completedAt !== null && (
        <span className="shrink-0 text-caption text-tertiary tabular">
          {shortDuration(run.completedAt - run.startedAt)}
        </span>
      )}
      <span className="flex-1" />
      <Button
        variant="default"
        size="xs"
        data-git-row=""
        tabIndex={-1}
        className="shrink-0"
        onClick={onFix}
      >
        <Glyph icon={MagicWand01Icon} size={12} />
        {t('next.action.handOffFix')}
      </Button>
    </div>
  )
}
