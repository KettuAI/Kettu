import { useState, type ReactNode } from 'react'
import type { TFunction } from 'i18next'
import {
  Alert02Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  CloudUploadIcon,
  Copy01Icon,
  Download04Icon,
  Edit02Icon,
  GitBranchIcon,
  GitCommitIcon,
  GitCompareIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  LinkSquare02Icon,
  MagicWand01Icon,
  SparklesIcon,
  Tick02Icon,
  Upload04Icon,
} from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { ChangedFile, GitStatus, GitTools, PullRequest } from '@shared/git'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { Glyph } from '@renderer/features/shell/glyph'
import { longAgo, shortDuration } from '@renderer/lib/format'
import { useNow, useSeconds } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import {
  openGitDialog,
  useGitStore,
  type GitOperationKind,
  type RunningOperation,
} from '@renderer/stores/git'
import { handOffText } from './hand-off'
import {
  compareUrl,
  continueCommand,
  journeyOf,
  nextStepOf,
  type JourneyStep,
  type JourneyTone,
  type NextAction,
  type NextButton,
  type NextKind,
  type NextStep,
  type NextTone,
} from './next-step'
import type { OpenGitPane } from './pane/open-pane'
import { OPERATION } from './results'
import { pushFromPopover, runStep } from './steps'
import { commandOf, failureOf, lastLine, stepOf, type OperationKind } from './sync'

const DOT: Record<JourneyTone, string> = {
  todo: 'bg-surface text-tertiary shadow-[0_0_0_1.5px_var(--border-strong)]',
  done: 'bg-success text-(--bg-surface)',
  now: 'bg-(--primary-foreground) text-(--bg-surface) shadow-[0_0_0_4px_var(--primary-from)]',
  fail: 'bg-danger text-(--bg-surface) shadow-[0_0_0_4px_color-mix(in_srgb,var(--danger)_16%,transparent)]',
  hold: 'bg-warning text-(--bg-surface) shadow-[0_0_0_4px_color-mix(in_srgb,var(--warning)_16%,transparent)]',
  merged: 'bg-merged text-(--bg-surface)',
}

const STEP_ICON: Record<JourneyStep['id'], IconSvgElement> = {
  uncommitted: Edit02Icon,
  local: GitCommitIcon,
  pushed: CloudUploadIcon,
  pr: GitPullRequestIcon,
  merge: GitMergeIcon,
}

/** Whether the line on a step's left or right side shows the way already taken. */
function lit(steps: JourneyStep[], index: number, side: 'before' | 'after'): boolean {
  const tone = steps[index]!.tone
  if (side === 'after') return tone === 'done'
  return tone === 'done' || tone === 'now' || steps[index - 1]?.tone === 'done'
}

/** Five steps from uncommitted work to a merge, each with what it holds. */
export function Journey({
  status,
  pr,
  gh,
}: {
  status: GitStatus
  pr: PullRequest | null
  gh: GitTools['gh']['state'] | null
}) {
  const { t } = useTranslation('git')
  const now = useNow()
  const steps = journeyOf(status, pr, gh)
  return (
    <ol aria-label={t('journey.title')} className="mt-3.5 -mx-0.5 grid auto-cols-fr grid-flow-col">
      {steps.map((step, i) => {
        const values = {
          ...step.values,
          ...(step.at !== null && { when: longAgo(step.at, now) }),
        }
        const line = 'absolute top-2.25 h-0.5 w-[calc(50%-12px)]'
        return (
          <li key={step.id} className="relative flex min-w-0 flex-col items-center text-center">
            {i > 0 && (
              <span
                aria-hidden
                className={cn(
                  line,
                  'left-0',
                  lit(steps, i, 'before') ? 'bg-success/45' : 'bg-border-strong',
                )}
              />
            )}
            {i < steps.length - 1 && (
              <span
                aria-hidden
                className={cn(
                  line,
                  'right-0',
                  lit(steps, i, 'after') ? 'bg-success/45' : 'bg-border-strong',
                )}
              />
            )}
            <span
              className={cn(
                'relative z-1 grid size-5 place-items-center rounded-full',
                DOT[step.tone],
              )}
            >
              {step.count !== null ? (
                <span className="text-caption leading-none font-semibold tabular">
                  {step.count}
                </span>
              ) : step.tone === 'done' && step.id === 'pushed' ? (
                <Glyph icon={Tick02Icon} size={11} />
              ) : (
                <Glyph icon={STEP_ICON[step.id]} size={11} />
              )}
            </span>
            <span
              className={cn(
                'mt-1.75 text-small leading-snug whitespace-nowrap',
                step.tone === 'todo' ? 'text-tertiary' : 'font-medium text-primary',
              )}
            >
              {t(`journey.label.${step.label}`, values)}
            </span>
            <span className="max-w-full truncate text-caption leading-snug text-tertiary">
              {step.note ? t(`journey.note.${step.note}`, values) : '—'}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

const TILE: Record<NextTone, string> = {
  primary: 'text-(--primary-foreground)',
  danger: 'text-danger',
  warning: 'text-warning',
  success: 'text-success',
  merged: 'text-merged',
  quiet: 'text-tertiary',
}

const KIND_ICON: Record<NextKind, IconSvgElement> = {
  conflicts: Alert02Icon,
  continue: Alert02Icon,
  commit: GitCommitIcon,
  noBranch: GitBranchIcon,
  publishRepo: CloudUploadIcon,
  blocked: Alert02Icon,
  diverged: GitCompareIcon,
  pull: Download04Icon,
  push: Upload04Icon,
  publishBranch: CloudUploadIcon,
  createPr: GitPullRequestIcon,
  fixChecks: Cancel01Icon,
  waiting: Clock01Icon,
  merge: CheckmarkCircle02Icon,
  merged: GitMergeIcon,
  closed: GitPullRequestClosedIcon,
  upToDate: CheckmarkCircle02Icon,
}

const ACTION_ICON: Record<NextAction, IconSvgElement> = {
  commit: SparklesIcon,
  commitAndPush: Upload04Icon,
  handOffConflicts: MagicWand01Icon,
  copyContinue: Copy01Icon,
  handOffRebase: MagicWand01Icon,
  pull: Download04Icon,
  push: Upload04Icon,
  publishBranch: CloudUploadIcon,
  publishRepo: CloudUploadIcon,
  createPr: GitPullRequestIcon,
  openCompare: LinkSquare02Icon,
  handOffFix: MagicWand01Icon,
  openPr: LinkSquare02Icon,
  mergeOnGitHub: LinkSquare02Icon,
  switchDefault: GitBranchIcon,
}

/** The write a button runs while it spins, so its own button shows the progress. */
const RUNS: Partial<Record<NextAction, GitOperationKind[]>> = {
  pull: ['pull'],
  push: ['push', 'publishBranch'],
  publishBranch: ['push', 'publishBranch'],
  publishRepo: ['publishRepo'],
  switchDefault: ['switch'],
}

const SYNC_KIND: Partial<Record<NextAction, OperationKind>> = {
  pull: 'pull',
  push: 'push',
  publishBranch: 'publishBranch',
  publishRepo: 'publishRepo',
}

type BlockedVariant = 'unknownRemote' | 'localUpstream' | 'otherName'
type PushVariant = 'plain' | 'pr' | 'updatesPr'
type CreatePrVariant = 'ready' | 'noGh' | 'signedOut'
type WaitingVariant = 'draft' | 'conflicts' | 'checks' | 'review' | 'changes' | 'blocked'

/** The words for a card: its title, and the line under it. */
function wordsOf(
  step: NextStep,
  status: GitStatus,
  t: TFunction<'git'>,
): { title: string; note: string } {
  const v = step.values
  const operation = step.operation ? t(`next.operation.${step.operation}`) : ''
  const variant = step.variant
  switch (step.kind) {
    case 'conflicts':
      return {
        title: operation
          ? t('next.conflicts.title', { count: v.count as number, operation })
          : t('next.conflicts.titleLoose', { count: v.count as number }),
        note: t('next.conflicts.note'),
      }
    case 'continue':
      return {
        title: t('next.continue.title', { operation }),
        note: t('next.continue.note'),
      }
    case 'commit': {
      const counts =
        (v.insertions as number) + (v.deletions as number) > 0
          ? `+${v.insertions} −${v.deletions}`
          : ''
      const context =
        v.context === 'checks'
          ? t('next.commit.checks', { name: v.name })
          : v.context === 'unpublished'
            ? t('next.commit.unpublished')
            : ''
      return {
        title: t('next.commit.title', { count: v.count as number }),
        note: [counts, context].filter(Boolean).join(' · ') || t('next.commit.note'),
      }
    }
    case 'noBranch':
      return variant === 'detached'
        ? { title: t('popover.detached'), note: t('hint.noBranch') }
        : { title: t('popover.unborn'), note: t('next.noBranch.unborn') }
    case 'publishRepo':
      return {
        title: t('next.publishRepo.title'),
        note:
          step.primary?.reason === 'ghMissing'
            ? t('hint.ghMissing')
            : step.primary?.reason === 'ghSignedOut'
              ? t('hint.ghSignedOut')
              : t('hint.publishRepo'),
      }
    case 'blocked':
      return {
        title: t('next.blocked.title'),
        note: t(`hint.${variant as BlockedVariant}`, { upstream: v.upstream }),
      }
    case 'diverged':
      return {
        title: t('next.diverged.title', { upstream: v.upstream }),
        note: t('next.diverged.note'),
      }
    case 'pull':
      return {
        title: t('next.pull.title', { count: v.count as number }),
        note: t('next.pull.note', { upstream: v.upstream }),
      }
    case 'push':
      return {
        title: t('next.push.title', { count: v.count as number, remote: v.remote }),
        note: t(`next.push.note.${(variant ?? 'plain') as PushVariant}`, { number: v.number }),
      }
    case 'publishBranch':
      return {
        title: t('next.publishBranch.title', { remote: v.remote }),
        note: t('next.publishBranch.note', { count: v.count as number }),
      }
    case 'createPr':
      return {
        title: t('next.createPr.title'),
        note: t(`next.createPr.note.${(variant ?? 'ready') as CreatePrVariant}`, {
          base: v.base,
        }),
      }
    case 'fixChecks':
      return {
        title: t('next.fixChecks.title', { count: v.count as number, name: v.name }),
        note: t('next.fixChecks.note', { number: v.number }),
      }
    case 'waiting':
      return {
        title: t(`next.waiting.${variant as WaitingVariant}.title`, { base: v.base }),
        note: t(`next.waiting.${variant as WaitingVariant}.note`),
      }
    case 'merge': {
      const parts = [
        (v.count as number) > 0 && t('next.merge.checks', { count: v.count as number }),
        v.approved === 1 && t('next.merge.approved'),
        t('next.merge.clean', { base: v.base }),
      ]
      return { title: t('next.merge.title'), note: parts.filter(Boolean).join(' · ') }
    }
    case 'merged':
      return {
        title: t('next.merged.title', { base: v.base }),
        note: t('next.merged.note', { base: v.base }),
      }
    case 'closed':
      return { title: t('next.closed.title'), note: t('next.closed.note') }
    case 'upToDate':
      return {
        title: t('next.upToDate.title'),
        note:
          variant === 'synced'
            ? t('hint.upToDate', { upstream: v.upstream })
            : t('next.upToDate.empty', { branch: status.head.branch ?? '' }),
      }
  }
}

function labelOf(
  button: NextButton,
  step: NextStep,
  status: GitStatus,
  copied: boolean,
  t: TFunction<'git'>,
): string {
  const v = step.values
  switch (button.action) {
    case 'commit':
      return t('popover.commit')
    case 'commitAndPush':
      return step.variant === 'publish'
        ? t('next.action.commitAndPublish')
        : t('dialog.commit.commitAndPush')
    case 'handOffConflicts':
      return t('next.action.handOffConflicts')
    case 'copyContinue':
      return copied
        ? t('timeline.copied')
        : t('next.action.copyCommand', { command: continueCommand(status) ?? '' })
    case 'handOffRebase':
      return t('next.action.handOffRebase')
    case 'pull':
      return button.count > 0 && step.kind === 'diverged'
        ? t('next.action.pullCount', { count: button.count })
        : t('sync.pull')
    case 'push':
      return t('next.action.push', { count: button.count })
    case 'publishBranch':
      return t('next.action.publishBranch')
    case 'publishRepo':
      return t('sync.publishRepo')
    case 'createPr':
      return t('prPart.create')
    case 'openCompare':
      return t('pr.openOnGitHub')
    case 'handOffFix':
      return t('next.action.handOffFix')
    case 'openPr':
      return step.kind === 'merged'
        ? t('next.action.viewPr')
        : step.kind === 'merge'
          ? t('next.action.openPr')
          : t('pr.openOnGitHub')
    case 'mergeOnGitHub':
      return t('next.action.mergeOnGitHub')
    case 'switchDefault':
      return t('next.action.switchTo', { base: v.base })
  }
}

function Elapsed({ since }: { since: number }) {
  const now = useSeconds()
  return <span className="tabular">{shortDuration(now - since)}</span>
}

/**
 * The branch popover's lead: what to do next, in one sentence with a main button and at most one
 * more. It reads the same table the progress line does, so the two never disagree.
 */
export function NextStepCard({
  status,
  pr,
  gh,
  files,
  onClose,
  onHandOff,
  onOpenPane,
}: {
  status: GitStatus
  pr: PullRequest | null
  gh: GitTools['gh']['state'] | null
  /** The working tree's files, for the names a conflict hand-off lists. */
  files: readonly ChangedFile[] | null
  onClose: () => void
  /** Puts a sentence in the session's composer; the popover closes around it. */
  onHandOff: (text: string) => void
  /** Opens the Git pane, for the steps that are taken there. */
  onOpenPane: (request: Omit<OpenGitPane, 'panel'>) => void
}) {
  const { t } = useTranslation('git')
  const { projectPath } = status
  const step = nextStepOf(status, pr, gh)
  const running = useGitStore((s) => s.running[projectPath] ?? null)
  const failed = useGitStore((s) => s.failed[projectPath] ?? null)
  // A failure left from before the popover opened was reported then; only a new one shows here.
  const [seen] = useState(failed)
  const [copied, setCopied] = useState(false)
  const { title, note } = wordsOf(step, status, t)
  const recent = failed !== null && failed !== seen && !running ? failed : null

  const words = {
    upstream: status.upstream?.name ?? status.remote?.name ?? '',
    operation: t(`sync.step.${stepOf(status)}`),
  }

  const perform = (action: NextAction): void => {
    switch (action) {
      case 'commit':
        onClose()
        onOpenPane({ tab: 'changes', commit: { only: null, andPush: false } })
        return
      case 'commitAndPush':
        onClose()
        onOpenPane({ tab: 'changes', commit: { only: null, andPush: true } })
        return
      case 'handOffConflicts':
      case 'handOffRebase':
      case 'handOffFix': {
        const text = handOffText(action, status, pr, files, t)
        if (text) onHandOff(text)
        return
      }
      case 'copyContinue': {
        const command = continueCommand(status)
        if (!command) return
        void navigator.clipboard.writeText(command).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
        return
      }
      case 'pull':
        void runStep(projectPath, { kind: 'pull' })
        return
      case 'push':
      case 'publishBranch':
      case 'publishRepo':
        pushFromPopover(status, SYNC_KIND[action]!, onClose)
        return
      case 'createPr':
        onClose()
        onOpenPane({ tab: 'pr' })
        return
      case 'switchDefault':
        if (status.defaultBranch) {
          void runStep(projectPath, { kind: 'switch', branch: status.defaultBranch, create: false })
        }
        return
      default:
        return
    }
  }

  const hrefOf = (action: NextAction): string | null =>
    action === 'openCompare'
      ? compareUrl(status)
      : action === 'openPr' || action === 'mergeOnGitHub'
        ? (pr?.url ?? null)
        : null

  const buttons = [step.primary, step.secondary].filter((b): b is NextButton => b !== null)
  return (
    <div className="mt-3.5 flex flex-col gap-2.5 rounded-card bg-subtle p-3">
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            'grid size-7 shrink-0 place-items-center rounded-xl bg-surface shadow-outline',
            TILE[step.tone],
          )}
        >
          <Glyph icon={KIND_ICON[step.kind]} size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="text-control leading-snug font-semibold [overflow-wrap:anywhere]">
            {title}
          </h4>
          {recent ? (
            <p className="mt-0.5 text-small leading-normal text-danger [overflow-wrap:anywhere]">
              {recent.busy
                ? t('failure.busy')
                : t(`failure.${failureOf(recent.log)}`, {
                    operation: t(`failure.operation.${OPERATION[recent.kind]}`),
                    detail: lastLine(recent.log),
                  })}
              {recent.log && (
                <button
                  type="button"
                  tabIndex={-1}
                  data-git-row=""
                  className="ml-1.5 rounded-sm text-tertiary underline decoration-border-strong underline-offset-2 outline-none hover:text-primary focus-ring"
                  onClick={() => {
                    onClose()
                    openGitDialog(projectPath, { kind: 'log' })
                  }}
                >
                  {t('failure.showLog')}
                </button>
              )}
            </p>
          ) : (
            <p className="mt-0.5 text-small leading-normal text-tertiary [overflow-wrap:anywhere]">
              {note}
            </p>
          )}
        </div>
      </div>
      {buttons.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {buttons.map((button, i) => (
            <ActionButton
              key={button.action}
              button={button}
              primary={i === 0}
              label={labelOf(button, step, status, copied, t)}
              icon={
                button.action === 'copyContinue' && copied
                  ? Tick02Icon
                  : button.action === 'commitAndPush' && step.variant === 'publish'
                    ? CloudUploadIcon
                    : ACTION_ICON[button.action]
              }
              href={hrefOf(button.action)}
              running={running}
              reason={
                button.reason === 'pushFirst'
                  ? t('next.reason.pushFirst')
                  : button.reason
                    ? t(`reason.${button.reason}`, words)
                    : null
              }
              command={commandText(button.action, status)}
              onClose={onClose}
              onRun={() => perform(button.action)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function commandText(action: NextAction, status: GitStatus): string | null {
  const kind = SYNC_KIND[action]
  return kind ? commandOf(status, kind) : null
}

function ActionButton({
  button,
  primary,
  label,
  icon,
  href,
  running,
  reason,
  command,
  onClose,
  onRun,
}: {
  button: NextButton
  primary: boolean
  label: string
  icon: IconSvgElement
  href: string | null
  running: RunningOperation | null
  reason: string | null
  command: string | null
  onClose: () => void
  onRun: () => void
}): ReactNode {
  const { t } = useTranslation('git')
  const mine = running !== null && (RUNS[button.action]?.includes(running.kind) ?? false)
  const className = 'min-w-0 flex-auto'
  const variant = primary ? 'default' : 'outline'
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        tabIndex={-1}
        data-git-row=""
        onClick={onClose}
        className={buttonVariants({ variant, size: 'sm', className })}
      >
        <Glyph icon={icon} size={14} />
        <span className="truncate">{label}</span>
      </a>
    )
  }
  const disabled = !button.enabled || running !== null
  const view = (
    <Button
      variant={variant}
      size="sm"
      data-git-row=""
      tabIndex={-1}
      disabled={disabled}
      aria-busy={mine || undefined}
      onClick={onRun}
      className={cn(className, 'w-full', mine && 'disabled:opacity-100')}
    >
      {mine ? <Spinner className="size-3.5" /> : <Glyph icon={icon} size={14} />}
      <span className="truncate">{label}</span>
      {mine && running && <Elapsed since={running.startedAt} />}
    </Button>
  )
  const tip = reason ?? (running && !mine ? t('sync.waiting') : command)
  if (mine || !tip) return <span className={cn('inline-flex', className)}>{view}</span>
  return (
    <Tooltip>
      {/* A disabled button gets no pointer events, so a wrapper holds the tooltip. */}
      <TooltipTrigger render={<span className={cn('inline-flex', className)} />}>
        {view}
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  )
}
