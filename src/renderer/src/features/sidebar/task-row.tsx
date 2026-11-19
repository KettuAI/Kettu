import { memo, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  MoreHorizontalIcon,
  PinIcon,
  PinOffIcon,
  UserIcon,
} from '@hugeicons/core-free-icons'
import { AnimatePresence, motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { SessionPullRequest, SessionSummary } from '@shared/agent-host'
import type { TaskSummary, TaskView } from '@shared/workflow'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { Glyph } from '@renderer/features/shell/glyph'
import {
  latestRound,
  stepRowStatus,
  stepTitle,
  taskRowStatus,
} from '@renderer/features/tasks/model'
import { TaskCard } from '@renderer/features/tasks/task-card'
import type { RowStatus } from './row-status'
import {
  CancelTaskDialog,
  DeleteTaskDialog,
  TaskMenuItems,
  TaskTitleField,
} from '@renderer/features/tasks/task-menu'
import { updateTask } from '@renderer/features/tasks/actions'
import { TaskRing } from '@renderer/features/tasks/task-ring'
import { useTaskSessions, useTaskView } from '@renderer/features/tasks/use-task'
import { hostOfPath } from '@renderer/lib/host-paths'
import { cn } from '@renderer/lib/utils'
import { isAway, useOtherHost } from '@renderer/stores/hosts'
import { useSessionsStore } from '@renderer/stores/sessions'
import { startedSteps, type StepRow } from '@renderer/stores/tasks'
import { openSession, openTask, useViewStore } from '@renderer/stores/view'
import { RenameHints } from './rename-hints'
import { useRenameHints } from './rename-scope'
import { isReturning, rowVariants } from './row-exit'
import { SessionCard } from './session-card'
import { useSessionCache } from './session-cache'
import { RowEnd, SessionIndicator } from './session-indicator'
import { sessionPullRequests } from './session-prs'
import { INDENT_PAD, NESTED_STEP, ROW_PAD, TreeLine } from './session-row'
import { PullRequestsBadge } from './pr-badge'
import { useRenaming } from './use-renaming'

/**
 * A task in its project, as a session's row: the caret, its progress ring in place of an agent's
 * mark, its title, the pull requests of its branch and the session row's one status slot over the
 * task and its steps. Its started steps hang under it as sub-sessions do, each with its agent's
 * mark; folded, it shows which step it is on where a session counts its sub-sessions. The task in
 * front is expanded and the others folded, until the user folds or unfolds one.
 */
export const TaskRow = memo(function TaskRow({
  task,
  tabStopId,
  showHost = false,
  indent = false,
  flat = false,
}: {
  task: TaskSummary
  tabStopId: string | null
  showHost?: boolean
  indent?: boolean
  /** In Needs you, where a row stands alone, without its steps. */
  flat?: boolean
}) {
  const { t } = useTranslation(['tasks', 'sidebar'])
  const hostId = hostOfPath(task.projectPath)
  const otherHost = useOtherHost(hostId)
  const away = isAway(otherHost?.connection ?? null)
  const hostName = hostId === null ? t('sidebar:hosts.thisComputer') : (otherHost?.name ?? '')
  const current = useViewStore(
    (s) => !s.settings.open && s.main.kind === 'task' && s.main.taskId === task.id,
  )
  const frontSession = useViewStore((s) =>
    !s.settings.open && s.main.kind === 'session' ? s.main.sessionId : null,
  )
  const inFront = useSessionsStore(
    (s) => current || (frontSession !== null && s.byId[frontSession]?.task?.taskId === task.id),
  )
  const userExpanded = useViewStore((s) => s.expandedParents[task.id])
  const steps = useMemo(() => startedSteps(task), [task])
  const hasSteps = steps.length > 0 && !flat
  const expanded = hasSteps && (userExpanded ?? inFront)
  const setExpanded = (value: boolean) =>
    useViewStore.setState((s) => ({ expandedParents: { ...s.expandedParents, [task.id]: value } }))

  const sessionIds = steps.flatMap((row) => row.step.sessionId ?? [])
  const sessions = useSessionsStore(useShallow((s) => sessionIds.map((id) => s.byId[id])))
  const missing = sessionIds.filter((_, i) => !sessions[i]).join(',')
  useTaskSessions(task.id, missing, !away)
  const [cardOpen, setCardOpen] = useState(false)
  const { view } = useTaskView(task.id, (expanded || cardOpen) && !away)

  const [moreOpen, setMoreOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const variants = useMemo(() => rowVariants(task.id), [task.id])
  const row = useRef<HTMLDivElement>(null)
  const rename = useRenaming(() => row.current?.querySelector<HTMLElement>('[data-sidebar-row]'))
  const ownHints = useRenameHints(rename.renaming)
  const base = indent ? INDENT_PAD : ROW_PAD
  const status = taskRowStatus(task, sessions, !expanded, view)
  const prs = useMemo(() => pullRequestsOf(sessions), [sessions])
  const folded = hasSteps && !expanded
  const progress =
    folded && task.status === 'running' && task.at !== null
      ? { at: task.at, total: task.steps.length }
      : null
  const tabStop = tabStopId === task.id
  const pinned = !!task.pinnedAt

  const caret = hasSteps && (
    <span
      role="button"
      tabIndex={-1}
      aria-label={expanded ? t('row.collapse') : t('row.expand')}
      onClick={(event) => {
        event.stopPropagation()
        setExpanded(!expanded)
      }}
      className="-mr-1.5 -ml-4 grid size-3.5 shrink-0 place-items-center rounded-sm text-(--faint) hover:text-(--ink)"
    >
      <Glyph icon={expanded ? ArrowDown01Icon : ArrowRight01Icon} size={12} />
    </span>
  )
  const mark = (
    <span className="ui-as-chat-row__logo relative">
      <TaskRing task={task} />
    </span>
  )

  const button = (
    <button
      type="button"
      className={cn('ui-as-side__item ui-as-chat-row__link', away && 'text-(--faint)!')}
      data-sidebar-row=""
      data-task-id={task.id}
      tabIndex={tabStop ? 0 : -1}
      aria-current={current ? 'page' : undefined}
      aria-expanded={hasSteps ? expanded : undefined}
      onClick={() => openTask(task.id)}
      onDoubleClick={rename.start}
      onKeyDown={(event) => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault()
          setMoreOpen(true)
          return
        }
        if (event.key === 'F2') {
          event.preventDefault()
          rename.start()
          return
        }
        if (!hasSteps) return
        if (event.key === 'ArrowRight' && !expanded) {
          event.preventDefault()
          setExpanded(true)
        } else if (event.key === 'ArrowLeft' && expanded) {
          event.preventDefault()
          setExpanded(false)
        }
      }}
      style={{ paddingLeft: base }}
    >
      {caret}
      {mark}
      <span className="ui-as-side__text" dir="auto">
        {task.title}
      </span>
      {prs.length > 0 && <PullRequestsBadge prs={prs} onEnter={() => setCardOpen(false)} />}
      {progress && (
        <span
          aria-label={t('row.stepOf', progress)}
          className="shrink-0 text-[12px] font-normal text-(--faint) tabular-nums"
        >
          {t('progress', progress)}
        </span>
      )}
      <RowEnd>
        {showHost && hostName && (
          <span className="max-w-24 truncate text-[12px] font-normal text-(--faint)">
            {hostName}
          </span>
        )}
        {!away && <SessionIndicator status={status} expiring={null} />}
      </RowEnd>
    </button>
  )

  const menuItems = (
    <TaskMenuItems
      task={task}
      onRename={rename.menu.onRename}
      onCancel={() => setCancelling(true)}
      onDelete={() => setDeleting(true)}
    />
  )

  return (
    <motion.li
      className="flex flex-col"
      variants={variants}
      initial={isReturning(task.id) ? 'hidden' : false}
      animate="shown"
      exit="exit"
    >
      <div
        ref={row}
        className="ui-as-chat-row"
        data-indent={indent || undefined}
        data-menu={menuOpen || moreOpen || undefined}
      >
        {rename.renaming ? (
          <>
            <div
              className="ui-as-chat-row__rename flex items-center gap-2"
              style={{ paddingLeft: base - 1 }}
            >
              {caret}
              {mark}
              <TaskTitleField
                task={task}
                onDone={rename.finish}
                className="h-full min-w-0 flex-1 bg-transparent outline-none selection:bg-edit-selection aria-invalid:text-danger"
              />
            </div>
            {ownHints && <RenameHints />}
          </>
        ) : (
          <>
            <ContextMenu
              onOpenChange={setMenuOpen}
              onOpenChangeComplete={rename.menu.onOpenChangeComplete}
            >
              <HoverCard
                open={cardOpen}
                onOpenChange={(open) =>
                  setCardOpen(open && !row.current?.querySelector('[data-pr-badge]:hover'))
                }
              >
                <HoverCardTrigger
                  delay={600}
                  closeDelay={0}
                  render={<ContextMenuTrigger render={button} />}
                />
                <HoverCardContent
                  side="right"
                  align="start"
                  sideOffset={10}
                  alignOffset={-4}
                  className="pointer-events-none w-[272px] px-3.5 py-3"
                >
                  <TaskCard task={task} view={view} />
                </HoverCardContent>
              </HoverCard>
              <ContextMenuContent finalFocus={rename.menu.finalFocus}>
                {menuItems}
              </ContextMenuContent>
            </ContextMenu>
            <span className="ui-as-chat-row__tools">
              <DropdownMenu
                open={moreOpen}
                onOpenChange={setMoreOpen}
                onOpenChangeComplete={rename.menu.onOpenChangeComplete}
              >
                <DropdownMenuTrigger
                  render={
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={t('sidebar:row.moreFor', { title: task.title })}
                      title={t('sidebar:row.more')}
                      className="ui-as-chat-row__tool"
                    />
                  }
                >
                  <Glyph icon={MoreHorizontalIcon} size={15} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" finalFocus={rename.menu.finalFocus}>
                  {menuItems}
                </DropdownMenuContent>
              </DropdownMenu>
              <button
                type="button"
                tabIndex={-1}
                aria-label={pinned ? t('sidebar:row.unpin') : t('sidebar:row.pin')}
                aria-pressed={pinned}
                title={pinned ? t('sidebar:row.unpin') : t('sidebar:row.pin')}
                onClick={() => void updateTask(task.id, { pinned: !pinned }).catch(() => {})}
                className="ui-as-chat-row__tool ui-as-chat-row__pin"
              >
                <Glyph icon={pinned ? PinOffIcon : PinIcon} size={14} />
              </button>
            </span>
          </>
        )}
      </div>
      {expanded && (
        <ul className="flex flex-col">
          <AnimatePresence initial={false}>
            {steps.map((step, i) => (
              <StepRowItem
                key={step.id}
                task={task}
                view={view}
                row={step}
                summary={
                  step.step.sessionId
                    ? sessions[sessionIds.indexOf(step.step.sessionId)]
                    : undefined
                }
                tabStopId={tabStopId}
                base={base}
                indent={indent}
                last={i === steps.length - 1}
                away={away}
              />
            ))}
          </AnimatePresence>
        </ul>
      )}
      <CancelTaskDialog task={task} open={cancelling} onOpenChange={setCancelling} />
      <DeleteTaskDialog task={task} open={deleting} onOpenChange={setDeleting} />
    </motion.li>
  )
})

/** A task's pull requests: those its steps' sessions opened or found on its branch, once each. */
function pullRequestsOf(sessions: readonly (SessionSummary | undefined)[]): SessionPullRequest[] {
  const byUrl = new Map<string, SessionPullRequest>()
  for (const summary of sessions) {
    if (!summary) continue
    for (const pr of sessionPullRequests(summary)) if (!byUrl.has(pr.url)) byUrl.set(pr.url, pr)
  }
  return [...byUrl.values()]
}

/**
 * A started step under its task, as a sub-session under its parent: its agent's mark and its
 * name, and its own session's status. It opens its session; a person's step, which has none, opens
 * the task.
 */
function StepRowItem({
  task,
  view,
  row,
  summary,
  tabStopId,
  base,
  indent,
  last,
  away,
}: {
  task: TaskSummary
  view: TaskView | undefined
  row: StepRow
  summary: SessionSummary | undefined
  tabStopId: string | null
  base: number
  indent: boolean
  last: boolean
  away: boolean
}) {
  const { t } = useTranslation('tasks')
  const { step } = row
  const hostId = hostOfPath(task.projectPath)
  const current = useViewStore(
    (s) =>
      !s.settings.open && s.main.kind === 'session' && !!summary && s.main.sessionId === summary.id,
  )
  const variants = useMemo(() => rowVariants(row.id), [row.id])
  const status = stepRowStatus(step, summary, latestRound(view, step.id))
  const name = stepTitle(view?.workflow, step.id, step.name)
  const open = () => (summary ? openSession(summary.id, summary.projectPath) : openTask(task.id))
  const button = (
    <button
      type="button"
      className={cn('ui-as-side__item ui-as-chat-row__link', away && 'text-(--faint)!')}
      data-sidebar-row=""
      data-session-id={summary?.id}
      tabIndex={tabStopId === row.id ? 0 : -1}
      aria-current={current ? 'page' : undefined}
      aria-label={t('row.step', { step: name, task: task.title })}
      onClick={open}
      style={{ paddingLeft: base + NESTED_STEP }}
    >
      <span className="ui-as-chat-row__logo relative">
        {step.agentId ? (
          <AgentMark agent={step.agentId} size={14} hostId={hostId} />
        ) : (
          <Glyph icon={UserIcon} size={14} />
        )}
      </span>
      <span className="ui-as-side__text" dir="auto">
        {name}
      </span>
      {!away && <SessionIndicator status={status} expiring={null} className="kettu-row-end" />}
    </button>
  )
  return (
    <motion.li
      className="flex flex-col"
      variants={variants}
      initial={false}
      animate="shown"
      exit="exit"
    >
      <div className="ui-as-chat-row" data-indent={indent || undefined}>
        <TreeLine last={last} left={base + 7} />
        {summary ? <StepHover summary={summary} status={status} button={button} /> : button}
      </div>
    </motion.li>
  )
}

/** A step's row with its session's hover card, as a session row has. */
function StepHover({
  summary,
  status,
  button,
}: {
  summary: SessionSummary
  status: RowStatus
  button: ReactElement
}) {
  const cache = useSessionCache(summary)
  return (
    <HoverCard>
      <HoverCardTrigger delay={600} closeDelay={0} render={button} />
      <HoverCardContent
        side="right"
        align="start"
        sideOffset={10}
        alignOffset={-4}
        className="pointer-events-none w-[272px] px-3.5 py-3"
      >
        <SessionCard summary={summary} cache={cache} status={status} />
      </HoverCardContent>
    </HoverCard>
  )
}
