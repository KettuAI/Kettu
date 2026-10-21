import { useShallow } from 'zustand/react/shallow'
import { memo, useEffect, useState } from 'react'
import { BotIcon, ChevronDownIcon, ChevronRightIcon, CornerDownRightIcon } from 'lucide-react'
import { createSession, deleteSession, descendantCount, closeSession } from '@renderer/app/actions'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { SidebarMenuButton, SidebarMenuItem } from '@renderer/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { PrIcon } from '@renderer/features/git/pr-icon'
import { PR_STATE_TEXT } from '@renderer/features/git/pr-text'
import { cn } from '@renderer/lib/utils'
import { isInstalled, usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { sessionTitle, type SessionNode } from '@renderer/stores/sessions'
import { openSession, useViewStore } from '@renderer/stores/view'
import { SessionIndicator } from './session-indicator'

/** The sidebar indents two levels at most and lists deeper sub-sessions at the second level. */
const MAX_DEPTH = 2

export const SessionRow = memo(function SessionRow({
  node,
  depth = 0,
}: {
  node: SessionNode
  depth?: number
}) {
  const { summary, children } = node
  const current = useViewStore(
    (s) => s.main.kind === 'session' && s.main.sessionId === summary.id && !s.settings.open,
  )
  const userExpanded = useViewStore((s) => s.expandedParents[summary.id])
  const hasChildren = children.length > 0
  const childActive = children.some((c) => c.running || c.permissionCount > 0)
  const expanded = hasChildren && (userExpanded ?? childActive)

  // A parent expands by itself the first time a sub-session needs attention, then stays as left.
  useEffect(() => {
    if (childActive && userExpanded === undefined) {
      useViewStore.setState((s) => ({
        expandedParents: { ...s.expandedParents, [summary.id]: true },
      }))
    }
  }, [childActive, userExpanded, summary.id])

  const setExpanded = (value: boolean) =>
    useViewStore.setState((s) => ({
      expandedParents: { ...s.expandedParents, [summary.id]: value },
    }))

  const [confirmDelete, setConfirmDelete] = useState(false)
  const pad = 26 + Math.min(depth, MAX_DEPTH) * 16
  const subagent = summary.origin === 'subagent'

  const lead = subagent ? (
    <BotIcon className="text-muted-foreground" />
  ) : (
    <span className="relative grid size-3.5 shrink-0 place-items-center">
      <AgentMark
        agent={summary.agentId}
        size={14}
        className={cn(hasChildren && 'group-hover/menu-button:opacity-0')}
      />
      {hasChildren && (
        <span
          role="button"
          tabIndex={-1}
          aria-label={expanded ? 'Collapse sub-sessions' : 'Expand sub-sessions'}
          onClick={(event) => {
            event.stopPropagation()
            setExpanded(!expanded)
          }}
          className="absolute inset-0 grid place-items-center text-muted-foreground opacity-0 group-hover/menu-button:opacity-100"
        >
          {expanded ? (
            <ChevronDownIcon strokeWidth={2} className="size-3!" />
          ) : (
            <ChevronRightIcon strokeWidth={2} className="size-3!" />
          )}
        </span>
      )}
    </span>
  )

  const button = (
    <SidebarMenuButton
      size="row"
      isActive={current}
      data-sidebar-row=""
      data-session-id={summary.id}
      tabIndex={current ? 0 : -1}
      aria-current={current ? 'page' : undefined}
      aria-expanded={hasChildren ? expanded : undefined}
      onClick={() => openSession(summary.id, summary.projectPath)}
      onKeyDown={(event) => {
        if (!hasChildren) return
        if (event.key === 'ArrowRight' && !expanded) {
          event.preventDefault()
          setExpanded(true)
        } else if (event.key === 'ArrowLeft' && expanded) {
          event.preventDefault()
          setExpanded(false)
        }
      }}
      style={{ paddingLeft: pad }}
      className="pr-2 data-active:font-medium"
    >
      {lead}
      <span className="min-w-0 flex-1 truncate">
        {sessionTitle(summary)}
        {subagent && summary.description && (
          <span className="font-normal text-muted-foreground"> · {summary.description}</span>
        )}
      </span>
      {summary.pr && <PrIcon state={summary.pr.state} size={13} />}
      {hasChildren && !expanded && (
        <span
          aria-label={`${children.length} sub-sessions`}
          className="inline-flex items-center gap-0.5 text-[11.5px] text-muted-foreground tabular"
        >
          <CornerDownRightIcon strokeWidth={1.8} className="size-[11px]!" />
          {children.length}
        </span>
      )}
      <SessionIndicator
        summary={summary}
        permissionCount={node.permissionCount}
        running={node.running}
      />
    </SidebarMenuButton>
  )

  return (
    <SidebarMenuItem>
      <ContextMenu>
        <ContextMenuTrigger
          render={
            summary.branch ? (
              <Tooltip>
                <TooltipTrigger render={button} delay={700} />
                <TooltipContent side="right" className="flex-col items-start gap-0.5">
                  <span className="font-mono">{summary.branch}</span>
                  {summary.pr && (
                    <span className="opacity-70">
                      #{summary.pr.number} · {PR_STATE_TEXT[summary.pr.state]}
                    </span>
                  )}
                </TooltipContent>
              </Tooltip>
            ) : (
              button
            )
          }
        />
        <SessionMenu
          sessionId={summary.id}
          projectPath={summary.projectPath}
          canCreateChild={!subagent}
          onDelete={() => setConfirmDelete(true)}
        />
      </ContextMenu>
      {expanded && (
        <ul className="relative flex flex-col gap-px pt-px">
          <span
            aria-hidden
            className="absolute top-0 bottom-3.5 w-(--hairline) bg-border"
            style={{ left: pad + 7 }}
          />
          {children.map((child) => (
            <SessionRow key={child.summary.id} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
      <DeleteSessionDialog
        sessionId={summary.id}
        title={sessionTitle(summary)}
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
      />
    </SidebarMenuItem>
  )
})

function SessionMenu({
  sessionId,
  projectPath,
  canCreateChild,
  onDelete,
}: {
  sessionId: string
  projectPath: string
  canCreateChild: boolean
  onDelete: () => void
}) {
  const agents = useAgentsStore(useShallow((s) => usableAgents(s.order, s.byId)))
  return (
    <ContextMenuContent className="w-48">
      {canCreateChild && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>New sub-session</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {agents.map((agent) => (
              <ContextMenuItem
                key={agent.id}
                disabled={!isInstalled(agent)}
                onClick={() => void createSession(agent.id, projectPath, sessionId)}
              >
                <AgentMark agent={agent.id} size={14} mono={!isInstalled(agent)} />
                {agent.name}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      {canCreateChild && <ContextMenuSeparator />}
      <ContextMenuItem onClick={() => void closeSession(sessionId)}>Close</ContextMenuItem>
      <ContextMenuItem variant="destructive" onClick={onDelete}>
        Delete…
      </ContextMenuItem>
    </ContextMenuContent>
  )
}

export function DeleteSessionDialog({
  sessionId,
  title,
  open,
  onOpenChange,
}: {
  sessionId: string
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const count = open ? descendantCount(sessionId) : 0
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{title}”?</AlertDialogTitle>
          <AlertDialogDescription>
            The agent deletes its transcript too.
            {count > 0 &&
              ` ${count === 1 ? 'Its sub-session is' : `Its ${count} sub-sessions are`} deleted with it.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => void deleteSession(sessionId)}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
