import { memo, useMemo, useState } from 'react'
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  MoreHorizontalIcon,
  WorkflowSquare03Icon,
} from '@hugeicons/core-free-icons'
import { AnimatePresence, motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { TaskView } from '@shared/tasks'
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
import { SessionRow } from '@renderer/features/sidebar/session-row'
import { TurnDots } from '@renderer/features/session/turn-dots'
import { Glyph } from '@renderer/features/shell/glyph'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import { isAway, useOtherHost } from '@renderer/stores/hosts'
import { taskSessionNodes, useSessionsStore } from '@renderer/stores/sessions'
import { taskHost } from '@renderer/stores/tasks'
import { openTask, useViewStore } from '@renderer/stores/view'
import { nodeName, taskMark } from './model'
import { CancelTaskDialog, RemoveTaskDialog, TaskMenuItems } from './task-menu'

// As a session row's: in a project's folder it lines up with the folder's name.
const ROW_PAD = 6
const INDENT_PAD = 30

/**
 * A task among its project's sessions: its mark, its title, and its working node or state at the
 * end; its node sessions fold under it as a session's sub-sessions do.
 */
export const TaskRow = memo(function TaskRow({
  task,
  indent = false,
}: {
  task: TaskView
  indent?: boolean
}) {
  const { t } = useTranslation('tasks')
  const { t: ts } = useTranslation('sidebar')
  const hostId = taskHost(task)
  const away = isAway(useOtherHost(hostId)?.connection ?? null)
  const current = useViewStore(
    (s) => !s.settings.open && s.main.kind === 'task' && s.main.taskId === task.id,
  )
  const summaries = useSessionsStore(
    useShallow((s) => Object.values(s.byId).filter((x) => x.task?.taskId === task.id)),
  )
  const children = useMemo(
    () => taskSessionNodes(Object.fromEntries(summaries.map((x) => [x.id, x])), task.id),
    [summaries, task.id],
  )
  const userExpanded = useViewStore((s) => s.expandedParents[task.id])
  const childActive = children.some((c) => c.running || c.permissionCount > 0)
  const hasChildren = children.length > 0
  const expanded = hasChildren && (userExpanded ?? childActive)
  const setExpanded = (value: boolean) =>
    useViewStore.setState((s) => ({ expandedParents: { ...s.expandedParents, [task.id]: value } }))
  const [moreOpen, setMoreOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [removing, setRemoving] = useState(false)
  const pad = indent ? INDENT_PAD : ROW_PAD
  const waits = children.reduce((n, child) => n + child.permissionCount, 0)
  const mark = taskMark(task)
  // While it runs, the node whose session is working names where it is.
  const working = children.find((child) => child.running)?.summary.task?.nodeId ?? null
  const end = mark === 'running' ? nodeName(task, working) : null

  const caret = hasChildren && (
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

  const button = (
    <button
      type="button"
      data-sidebar-row=""
      data-task-id={task.id}
      tabIndex={-1}
      aria-current={current ? 'page' : undefined}
      aria-expanded={hasChildren ? expanded : undefined}
      className={cn('ui-as-side__item ui-as-chat-row__link', away && 'text-(--faint)!')}
      style={{ paddingLeft: pad }}
      onClick={() => openTask(task.id)}
      onKeyDown={(event) => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault()
          setMoreOpen(true)
          return
        }
        if (!hasChildren) return
        if (event.key === 'ArrowRight' && !expanded) {
          event.preventDefault()
          setExpanded(true)
        } else if (event.key === 'ArrowLeft' && expanded) {
          event.preventDefault()
          setExpanded(false)
        }
      }}
    >
      {caret}
      <span className="ui-as-chat-row__logo relative text-(--muted)">
        <Glyph icon={WorkflowSquare03Icon} size={14} />
      </span>
      <span className="ui-as-side__text" dir="auto">
        {task.title}
      </span>
      {hasChildren && !expanded && (
        <span
          aria-label={t('row.nodeSessions', { count: children.length })}
          className="shrink-0 text-[12px] font-normal text-(--faint) tabular-nums"
        >
          {children.length}
        </span>
      )}
      <span className="kettu-row-end max-w-28 shrink-0 truncate text-[12px] font-normal text-(--faint)">
        {end ?? t(`state.${mark}`)}
      </span>
      {!away && (
        <span className="kettu-row-end grid size-4 shrink-0 place-items-center">
          {mark === 'needsYou' ? (
            <span
              role="img"
              aria-label={ts('indicator.waiting', { count: Math.max(1, waits) })}
              className="size-2 rounded-full bg-attention-dot shadow-[0_0_0_3px_var(--attention-halo)]"
            />
          ) : mark === 'running' ? (
            <span role="img" aria-label={t('state.running')} className="grid">
              <TurnDots phase="working" />
            </span>
          ) : (mark === 'done' || mark === 'dropped') &&
            (task.lastViewedAt ?? 0) < (task.endedAt ?? task.updatedAt) ? (
            <span
              role="img"
              aria-label={ts('indicator.unread')}
              className="size-1.5 rounded-full bg-(--accent)"
            />
          ) : null}
        </span>
      )}
    </button>
  )

  const items = (
    <TaskMenuItems
      task={task}
      onCancel={() => setCancelling(true)}
      onRemove={() => setRemoving(true)}
    />
  )

  return (
    <motion.li
      className="flex flex-col"
      initial={false}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <div
        className="ui-as-chat-row"
        data-indent={indent || undefined}
        data-menu={menuOpen || moreOpen || undefined}
      >
        <ContextMenu onOpenChange={setMenuOpen}>
          <ContextMenuTrigger render={button} />
          <ContextMenuContent>{items}</ContextMenuContent>
        </ContextMenu>
        <span className="ui-as-chat-row__tools">
          <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={t('row.moreFor', { title: task.title })}
                  title={t('row.more')}
                  className="ui-as-chat-row__tool"
                />
              }
            >
              <Glyph icon={MoreHorizontalIcon} size={15} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">{items}</DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
      {expanded && (
        <ul className="flex flex-col">
          <AnimatePresence initial={false}>
            {children.map((child, i) => (
              <SessionRow
                key={child.summary.id}
                node={child}
                tabStopId={null}
                indent={indent}
                branch={i === children.length - 1 ? 'last' : 'middle'}
                label={t('row.nodeSession', {
                  node: nodeName(task, child.summary.task?.nodeId ?? null) ?? '',
                  agent: agentName(child.summary.agentId, hostId),
                })}
              />
            ))}
          </AnimatePresence>
        </ul>
      )}
      <CancelTaskDialog task={task} open={cancelling} onOpenChange={setCancelling} />
      <RemoveTaskDialog task={task} open={removing} onOpenChange={setRemoving} />
    </motion.li>
  )
})
