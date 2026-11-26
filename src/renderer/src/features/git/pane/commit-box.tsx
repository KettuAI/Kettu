import { useEffect, useRef, useState, type RefObject } from 'react'
import { ArrowDown01Icon, SparklesIcon, Upload04Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { ChangedFile, GitStatus } from '@shared/git'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Kbd } from '@renderer/components/ui/kbd'
import { Spinner } from '@renderer/components/ui/spinner'
import { Textarea } from '@renderer/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { Glyph } from '@renderer/features/shell/glyph'
import { errorMessage, host } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { formatShortcut, isMod } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import {
  EMPTY_BOX,
  ghStateOf,
  setLeftOut,
  setGitPaneTab,
  updateCommitBox,
  useGitStore,
} from '@renderer/stores/git'
import { lastLine, planSync, pushTargetOf, stepOf } from '../sync'
import { pushNow, runStep } from '../steps'
import { afterCommit, committable, tickedFiles } from './commit-selection'

const NO_PATHS: readonly string[] = []

/** What a commit does once it is made: nothing, a push, or a push and the pull request page. */
type Then = 'commit' | 'push' | 'pullRequest'

/**
 * The commit's message and its buttons, under the list of files. The agent's small model writes
 * the message from the ticked files, once on its own while the box is untouched and again when
 * asked; what the user typed is never replaced by a draft.
 */
export function CommitBox({
  status,
  files,
  panel,
  textarea,
  agentRunning,
}: {
  status: GitStatus
  /** Every changed file, null while they load. */
  files: readonly ChangedFile[] | null
  panel: string
  textarea: RefObject<HTMLTextAreaElement | null>
  /** The session's turn is running, so its files are still changing. */
  agentRunning: boolean
}) {
  const { t } = useTranslation('git')
  const { projectPath } = status
  const box = useGitStore((s) => s.box[projectPath] ?? EMPTY_BOX)
  const leftOut = useGitStore((s) => s.leftOut[projectPath] ?? NO_PATHS)
  const gh = useGitStore((s) => ghStateOf(s, hostOfPath(projectPath)))
  const pr = useGitStore((s) => s.currentPr[projectPath] ?? null)
  const running = useGitStore((s) => s.running[projectPath] ?? null)
  const [busy, setBusy] = useState<Then | null>(null)
  const { writing, problem } = box
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const ticked = files ? tickedFiles(files, leftOut) : []
  const total = files ? committable(files).length : 0
  const blocked = !!status.operation || status.changes.conflicted > 0
  const plan = planSync(status, gh)
  const pushable = pushTargetOf(status) !== null && plan.push.reason !== 'diverged'
  const prOffer =
    pushable && !pr && !!status.remote?.github && gh === 'ready' && status.defaultBranch !== null
  const message = box.message.trim()

  // A draft costs a small-model request, so it is asked for once while the box is untouched, and
  // not while the agent is still writing the files.
  const write = async (auto: boolean): Promise<void> => {
    const asked = useGitStore.getState().box[projectPath] ?? EMPTY_BOX
    if (asked.writing || busy || ticked.length === 0 || (auto && asked.drafted)) return
    updateCommitBox(projectPath, { drafted: true, writing: true, problem: null })
    try {
      // The list can still be the one from before a commit, so only files that still have changes count.
      const here = new Set((await host('git.changes', { projectPath })).map((file) => file.path))
      const paths = ticked.map((file) => file.path).filter((path) => here.has(path))
      if (paths.length === 0) {
        updateCommitBox(projectPath, { drafted: false, writing: false })
        return
      }
      const written = await host('git.commitMessage', { projectPath, paths })
      const now = useGitStore.getState().box[projectPath] ?? EMPTY_BOX
      updateCommitBox(
        projectPath,
        !auto || !now.edited
          ? { message: written, edited: false, writing: false }
          : { writing: false },
      )
    } catch (failure) {
      updateCommitBox(projectPath, { writing: false, problem: errorMessage(failure) })
    }
  }
  const wanted =
    ticked.length > 0 &&
    !box.edited &&
    !box.drafted &&
    box.message === '' &&
    !blocked &&
    !agentRunning
  useEffect(() => {
    if (wanted) void write(true)
    // `write` is rebuilt every render; `wanted` and the list say when a draft is called for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, files])

  const reason = blocked
    ? t(`sync.step.${stepOf(status)}`)
    : ticked.length === 0
      ? t('pane.box.tickFiles')
      : message === ''
        ? t('pane.box.writeMessage')
        : running
          ? t('sync.waiting')
          : null
  const commit = async (then: Then): Promise<void> => {
    if (reason !== null || busy || writing || !files) return
    setBusy(then)
    updateCommitBox(projectPath, { problem: null })
    const paths = ticked.map((file) => file.path)
    const done = await runStep(
      projectPath,
      { kind: 'commit', message, paths },
      { quietFailure: true, noNext: then !== 'commit' },
    )
    if (alive.current) setBusy(null)
    if (!done) {
      updateCommitBox(projectPath, {
        problem: useGitStore.getState().failed[projectPath]?.log ?? '',
      })
      return
    }
    updateCommitBox(projectPath, { ...EMPTY_BOX })
    setLeftOut(projectPath, afterCommit(files, leftOut, paths))
    if (then !== 'commit') pushNow(projectPath)
    if (then === 'pullRequest') setGitPaneTab(panel, 'pr')
  }
  // Mod+Enter does what the box was opened for: a commit, or Commit and push.
  const primary: Then = box.andPush && pushable ? 'push' : 'commit'

  return (
    <div className="@container mt-2 mb-1 shrink-0 rounded-2xl bg-card p-2.5 shadow-card">
      <div className="relative">
        <Textarea
          ref={textarea}
          value={box.message}
          rows={3}
          readOnly={writing}
          aria-label={t('dialog.commit.message')}
          placeholder={writing ? t('dialog.commit.writing') : t('dialog.commit.placeholder')}
          onChange={(event) =>
            updateCommitBox(projectPath, { message: event.target.value, edited: true })
          }
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return
            if (event.key === 'Enter' && isMod(event)) {
              event.preventDefault()
              void commit(primary)
            }
          }}
          className="max-h-44 min-h-16 resize-none border-0 bg-transparent py-1 pr-9 pl-1.5 leading-[1.5] shadow-none hover:border-0 focus-visible:shadow-none"
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="quiet"
                size="icon-xs"
                aria-label={t('dialog.commit.write')}
                disabled={ticked.length === 0 || !!busy || writing}
                onClick={() => void write(false)}
                className="absolute top-0.5 right-0.5 text-tertiary"
              />
            }
          >
            {writing ? <Spinner className="size-3.5" /> : <Glyph icon={SparklesIcon} size={14} />}
          </TooltipTrigger>
          <TooltipContent>
            {writing ? t('dialog.commit.writing') : t('dialog.commit.write')}
          </TooltipContent>
        </Tooltip>
      </div>
      {problem !== null && (
        <p
          role="alert"
          title={problem}
          className="mt-1 px-1.5 text-small leading-normal text-danger [overflow-wrap:anywhere]"
        >
          {lastLine(problem)}
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-small text-tertiary">
          <span className="font-medium text-primary tabular">
            {t('dialog.commit.filesChosen', { count: total, chosen: ticked.length })}
          </span>
          <Kbd className="ml-2 align-middle @max-sm:hidden">{formatShortcut('Mod+Enter')}</Kbd>
        </span>
        <CommitButton
          label={t('dialog.commit.commit')}
          busy={busy === 'commit'}
          disabled={reason !== null || !!busy || writing}
          reason={reason}
          variant="outline"
          onClick={() => void commit('commit')}
        />
        <span className="inline-flex">
          <CommitButton
            label={t('dialog.commit.commitAndPush')}
            icon={Upload04Icon}
            busy={busy === 'push'}
            disabled={reason !== null || !!busy || writing || !pushable}
            reason={reason ?? (pushable ? null : t('pane.box.cannotPush'))}
            variant="default"
            joined={prOffer ? 'start' : undefined}
            onClick={() => void commit('push')}
          />
          {prOffer && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="default"
                    size="sm"
                    aria-label={t('pane.box.moreWays')}
                    disabled={reason !== null || !!busy || writing}
                    className="-ml-px rounded-l-none border-l border-primary-foreground/20 px-1.5"
                  />
                }
              >
                <Glyph icon={ArrowDown01Icon} size={12} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuItem onClick={() => void commit('pullRequest')}>
                  {t('pane.box.commitPushAndPr')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </span>
      </div>
    </div>
  )
}

function CommitButton({
  label,
  icon,
  busy,
  disabled,
  reason,
  variant,
  joined,
  onClick,
}: {
  label: string
  icon?: typeof Upload04Icon
  busy: boolean
  disabled: boolean
  reason: string | null
  variant: 'outline' | 'default'
  joined?: 'start'
  onClick: () => void
}) {
  const button = (
    <Button
      variant={variant}
      size="sm"
      disabled={disabled}
      aria-busy={busy || undefined}
      onClick={onClick}
      className={cn(busy && 'disabled:opacity-100', joined && 'rounded-r-none')}
    >
      {busy ? <Spinner className="size-3.5" /> : icon && <Glyph icon={icon} size={14} />}
      {label}
    </Button>
  )
  if (!disabled || !reason) return button
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{button}</TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  )
}
