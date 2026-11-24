import { useRef, useState } from 'react'
import {
  Alert02Icon,
  ArrowDown01Icon,
  CheckmarkCircle02Icon,
  Copy01Icon,
  Download04Icon,
  GitBranchIcon,
  GitCommitIcon,
  LinkSquare02Icon,
  MagicWand01Icon,
  MoreHorizontalIcon,
  Upload04Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { ChangedFile, GitStatus, GitTools, PullRequest } from '@shared/git'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { Glyph } from '@renderer/features/shell/glyph'
import { hostPath } from '@renderer/lib/host-paths'
import { useNow } from '@renderer/lib/use-now'
import { openGitDialog, useGitStore } from '@renderer/stores/git'
import { BranchSwitcher } from '../branch-switcher'
import { WorktreeMark } from '../branch-popover'
import { FetchButton } from '../fetch-button'
import { handOffText } from '../hand-off'
import { continueCommand } from '../next-step'
import { branchName, fetchedText, isLinkedWorktree } from '../popover-keys'
import { pushNow, runStep } from '../steps'
import { planSync, PUSHING, stepOf } from '../sync'
import { ActionBtn, Note } from './pane-ui'

/** The branch, its worktree and an operation stopped midway. */
export function PaneTop({ status }: { status: GitStatus }) {
  const { t } = useTranslation('git')
  const [switching, setSwitching] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const { head, operation } = status
  const linked = isLinkedWorktree(status)
  const name = branchName(status)
  return (
    <div className="flex items-center gap-1.5 pb-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              ref={anchor}
              type="button"
              onClick={() => setSwitching(true)}
              className="inline-flex h-7 max-w-68 min-w-0 items-center gap-1.75 rounded-lg bg-subtle px-2.25 text-control font-medium text-primary outline-none hover:bg-hover focus-ring"
            />
          }
        >
          <Glyph
            icon={head.detached ? GitCommitIcon : GitBranchIcon}
            className="size-3.5 shrink-0 text-tertiary"
          />
          <span className="min-w-0 truncate">{name}</span>
          <Glyph icon={ArrowDown01Icon} className="size-3 shrink-0 text-placeholder" />
        </TooltipTrigger>
        <TooltipContent>{t('popover.switchBranch')}</TooltipContent>
      </Tooltip>
      {linked && <WorktreeMark root={status.repo ? hostPath(status.repo.root) : ''} />}
      {operation && (
        <span className="inline-flex h-4.5 shrink-0 items-center rounded-full bg-danger/11 px-1.75 text-caption font-medium whitespace-nowrap text-danger">
          {t(
            `status.operation.${operation.kind === 'cherry-pick' ? 'cherryPick' : operation.kind}`,
          )}
          {operation.step && ` ${operation.step[0]}/${operation.step[1]}`}
        </span>
      )}
      <BranchSwitcher
        status={status}
        open={switching}
        anchor={anchor}
        onOpenChange={setSwitching}
      />
    </div>
  )
}

/** Fetch and More, at the end of the Git tab's context bar. */
export function PaneTools({ status }: { status: GitStatus }) {
  const { t } = useTranslation('git')
  const failed = useGitStore((s) => s.failed[status.projectPath] ?? null)
  const name = branchName(status)
  const github = status.remote?.github
  return (
    <>
      <FetchButton status={status} />
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="quiet"
                    size="icon-sm"
                    aria-label={t('pane.more')}
                    className="text-tertiary"
                  />
                }
              />
            }
          >
            <Glyph icon={MoreHorizontalIcon} size={14} />
          </TooltipTrigger>
          <TooltipContent>{t('pane.more')}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem onClick={() => void navigator.clipboard.writeText(name)}>
            <Glyph icon={Copy01Icon} />
            {t('pane.copyBranch')}
          </DropdownMenuItem>
          {github && (
            <DropdownMenuItem
              render={
                <a
                  href={`https://github.com/${github.owner}/${github.repo}`}
                  target="_blank"
                  rel="noreferrer"
                />
              }
            >
              <Glyph icon={LinkSquare02Icon} />
              {t('pane.openRepository')}
            </DropdownMenuItem>
          )}
          {failed && (
            <DropdownMenuItem onClick={() => openGitDialog(status.projectPath, { kind: 'log' })}>
              <Glyph icon={Alert02Icon} />
              {t('failure.showLog')}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

/**
 * Where the branch stands against its remote, in one line with the buttons that move it: push,
 * pull and publish, or what to hand the agent when git stopped midway or the branch diverged.
 */
export function SyncStrip({
  status,
  pr,
  gh,
  files,
  onHandOff,
}: {
  status: GitStatus
  pr: PullRequest | null
  gh: GitTools['gh']['state'] | null
  /** The working tree's files, for the names a conflict hand-off lists. */
  files: readonly ChangedFile[] | null
  /** Puts a sentence in the session's composer. */
  onHandOff: (text: string) => void
}) {
  const { t } = useTranslation('git')
  const now = useNow()
  const running = useGitStore((s) => s.running[status.projectPath] ?? null)
  const [copied, setCopied] = useState(false)
  const { projectPath, upstream, operation, changes, head, remote } = status
  const plan = planSync(status, gh)
  const words = {
    upstream: upstream?.name ?? remote?.name ?? '',
    operation: t(`sync.step.${stepOf(status)}`),
  }
  const pushing = running !== null && PUSHING.has(running.kind)
  const pullReason = plan.pull.reason ? t(`reason.${plan.pull.reason}`, words) : null
  const pushReason = plan.push.reason ? t(`reason.${plan.push.reason}`, words) : null
  const hand = (action: 'handOffConflicts' | 'handOffRebase') => (): void => {
    const text = handOffText(action, status, pr, files, t)
    if (text) onHandOff(text)
  }

  const pull = (primary: boolean, count: number) => (
    <ActionBtn
      icon={Download04Icon}
      primary={primary}
      label={count > 0 ? t('next.action.pullCount', { count }) : t('sync.pull')}
      busy={running?.kind === 'pull'}
      disabled={!plan.pull.enabled || running !== null}
      reason={pullReason ?? (running ? t('sync.waiting') : null)}
      onClick={() => void runStep(projectPath, { kind: 'pull' })}
    />
  )

  if (changes.conflicted > 0 || operation) {
    const kind = operation?.kind ?? null
    const operationName = kind ? t(`next.operation.${kind}`) : ''
    const command = continueCommand(status)
    return (
      <Note
        icon={Alert02Icon}
        tone="bad"
        actions={
          <>
            {changes.conflicted > 0 && (
              <ActionBtn
                primary
                icon={MagicWand01Icon}
                label={t('next.action.handOffConflicts')}
                onClick={hand('handOffConflicts')}
              />
            )}
            {command && (
              <ActionBtn
                primary={changes.conflicted === 0}
                icon={Copy01Icon}
                label={copied ? t('timeline.copied') : t('next.action.copyCommand', { command })}
                onClick={() =>
                  void navigator.clipboard.writeText(command).then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1500)
                  })
                }
              />
            )}
          </>
        }
      >
        {changes.conflicted === 0
          ? t('next.continue.title', { operation: operationName })
          : kind
            ? t('next.conflicts.title', { count: changes.conflicted, operation: operationName })
            : t('next.conflicts.titleLoose', { count: changes.conflicted })}
      </Note>
    )
  }

  if (head.detached || head.branch === null || head.oid === null) {
    return (
      <Note icon={GitCommitIcon}>
        {head.detached ? t('popover.detached') : t('popover.unborn')}
      </Note>
    )
  }

  if (plan.push.kind === 'publishRepo') {
    return (
      <Note
        icon={Upload04Icon}
        actions={
          <ActionBtn
            primary
            icon={Upload04Icon}
            label={t('sync.publishRepo')}
            busy={running?.kind === 'publishRepo'}
            disabled={!plan.push.enabled || running !== null}
            reason={pushReason ?? (running ? t('sync.waiting') : null)}
            onClick={() => pushNow(projectPath)}
          />
        }
      >
        {t('sync.noRemote')}
      </Note>
    )
  }

  if (plan.hint === 'unknownRemote' || plan.hint === 'localUpstream' || plan.hint === 'otherName') {
    return (
      <Note icon={Alert02Icon} tone="warn">
        {t(`hint.${plan.hint}`, words)}
      </Note>
    )
  }

  const remoteName = status.push?.kind === 'remote' ? status.push.remote : (remote?.name ?? '')
  if (plan.push.kind === 'publishBranch') {
    return (
      <Note
        icon={Upload04Icon}
        actions={
          <ActionBtn
            primary
            icon={Upload04Icon}
            label={t('next.action.publishBranch')}
            busy={pushing}
            disabled={!plan.push.enabled || (running !== null && !pushing)}
            reason={pushReason}
            onClick={() => pushNow(projectPath)}
          />
        }
      >
        {t('pane.sync.notPublished', { remote: remoteName })}
      </Note>
    )
  }

  const ahead = upstream?.ahead ?? 0
  const behind = upstream?.behind ?? 0
  if (ahead > 0 && behind > 0) {
    return (
      <Note
        icon={Alert02Icon}
        tone="warn"
        actions={
          <>
            {pull(false, 0)}
            <ActionBtn
              primary
              icon={MagicWand01Icon}
              label={t('next.action.handOffRebase')}
              onClick={hand('handOffRebase')}
            />
          </>
        }
      >
        {t('pane.sync.diverged', { ahead, behind })}
      </Note>
    )
  }
  if (ahead > 0) {
    return (
      <Note
        icon={Upload04Icon}
        actions={
          <>
            {pull(false, 0)}
            <ActionBtn
              primary
              icon={Upload04Icon}
              label={t('next.action.push', { count: ahead })}
              busy={pushing}
              disabled={!plan.push.enabled || (running !== null && !pushing)}
              reason={pushReason}
              onClick={() => pushNow(projectPath)}
            />
          </>
        }
      >
        {t('pane.sync.toPush', { count: ahead, upstream: upstream?.name ?? remoteName })}
      </Note>
    )
  }
  if (behind > 0) {
    return (
      <Note icon={Download04Icon} actions={pull(true, behind)}>
        {t('pane.sync.toPull', { count: behind, upstream: upstream?.name ?? remoteName })}
      </Note>
    )
  }
  return (
    <Note icon={CheckmarkCircle02Icon} tone="ok">
      {t('pane.sync.inSync', {
        upstream: upstream?.name ?? remoteName,
        fetched: fetchedText(status, now, t),
      })}
    </Note>
  )
}
