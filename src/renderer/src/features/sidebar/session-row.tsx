import { memo, useEffect, useRef, useState } from 'react'
import { ChevronDownIcon, ChevronRightIcon, EllipsisIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
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
import { SidebarMenuButton, SidebarMenuItem } from '@renderer/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { PrIcon } from '@renderer/features/git/pr-icon'
import { cn } from '@renderer/lib/utils'
import { isAway, useOtherHost } from '@renderer/stores/hosts'
import { hostOfSession, sessionTitle, type SessionNode } from '@renderer/stores/sessions'
import { useSessionDragSource } from '@renderer/features/split/session-drag-model'
import { allPanes, paneWithSession } from '@renderer/features/split/layout'
import { openSession, useViewStore } from '@renderer/stores/view'
import { RenameHints } from './rename-hints'
import { useRenameHints } from './rename-scope'
import { rowStatus } from './row-status'
import { cacheGone, useGoneLabel, useSessionCache } from './session-cache'
import { SessionCard } from './session-card'
import { SessionIndicator } from './session-indicator'
import { DeleteSessionDialog, SessionMenuItems, SessionTitleField } from './session-menu'
import { runSessionMenuAccelerator } from './session-menu-model'
import { SubagentBadge } from './subagent-badge'
import { useRenaming } from './use-renaming'

/** A row's padding before its mark; a sub-session's row starts past its parent's tree line. */
const ROW_PAD = 10
const NESTED_PAD = 32

export const SessionRow = memo(function SessionRow({
  node,
  tabStopId,
  showHost = false,
  branch,
}: {
  node: SessionNode
  /** The id of the list's one Tab stop, which the row it names takes. */
  tabStopId: string | null
  /** The row ends with its host's name, as in a list across the hosts. */
  showHost?: boolean
  /** A sub-session's place under its parent, which the tree line follows. */
  branch?: 'middle' | 'last'
}) {
  const { t } = useTranslation('sidebar')
  const { summary, children } = node
  const hostId = hostOfSession(summary)
  const otherHost = useOtherHost(hostId)
  // What an offline host's session last said is not known to hold, so it shows no state.
  const away = isAway(otherHost?.connection ?? null)
  const hostName = hostId === null ? t('hosts.thisComputer') : (otherHost?.name ?? '')
  const shownId = useViewStore((s) =>
    s.main.kind === 'session' && !s.settings.open ? s.main.sessionId : null,
  )
  // A sub-agent has no row, so its parent's stands for it while it shows.
  const current =
    shownId !== null &&
    (shownId === summary.id || node.subagents.some((agent) => agent.id === shownId))
  // The rows of the other panes in view take the current row's fill as well.
  const inSplit = useViewStore(
    (s) =>
      !s.settings.open &&
      s.main.kind === 'session' &&
      s.main.sessionId !== summary.id &&
      !!paneWithSession(s.layout, summary.id) &&
      allPanes(s.layout).some(
        (pane) =>
          s.visiblePanes.includes(pane.id) &&
          pane.view.kind === 'session' &&
          pane.view.sessionId === summary.id,
      ),
  )
  const tabStop = tabStopId === summary.id
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

  const [deleting, setDeleting] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [cardOpen, setCardOpen] = useState(false)
  // The badge lists the sub-agents on its own hover, which the row's card leaves to it.
  const overBadge = useRef(false)
  const [badgeHovered, setBadgeHovered] = useState(false)
  const row = useRef<HTMLDivElement>(null)
  const rename = useRenaming(() => row.current?.querySelector<HTMLElement>('[data-sidebar-row]'))
  const drag = useSessionDragSource(summary.id, rename.renaming)
  const ownHints = useRenameHints(rename.renaming)
  const pad = branch ? NESTED_PAD : ROW_PAD
  const cache = useSessionCache(summary)
  const gone = useGoneLabel(cache)
  const expiring = cache?.state === 'ending' ? cache.cache : null
  // Collapsed, a parent speaks for its sub-sessions: their count and the loudest status.
  const status = rowStatus(node, hasChildren && !expanded)
  const title = sessionTitle(summary)

  const caret = hasChildren && (
    <span
      role="button"
      tabIndex={-1}
      aria-label={expanded ? t('row.collapse') : t('row.expand')}
      onClick={(event) => {
        event.stopPropagation()
        setExpanded(!expanded)
      }}
      className="-ml-1 grid size-3.5 shrink-0 place-items-center rounded-sm text-tertiary hover:text-primary"
    >
      {expanded ? (
        <ChevronDownIcon strokeWidth={1.6} className="size-[11px]!" />
      ) : (
        <ChevronRightIcon strokeWidth={1.6} className="size-[11px]!" />
      )}
    </span>
  )
  const mark = (
    <span className="relative grid size-4 shrink-0 place-items-center">
      <AgentMark
        agent={summary.agentId}
        size={16}
        className={cn(
          'transition-[filter,opacity] duration-(--duration-base)',
          cacheGone(cache) && 'opacity-40 grayscale',
        )}
      />
    </span>
  )

  const button = (
    <SidebarMenuButton
      ref={drag.ref}
      size="row"
      isActive={current}
      aria-description={inSplit ? t('row.inSplitView') : undefined}
      // The other panes' rows take the current row's fill, without its surface or its edge.
      className={cn(
        // The row its menu acts on keeps a fox ring while the menu is open; rows chosen together
        // take a fox tint.
        'gap-[9px] pr-2.5 text-row data-active:font-medium data-multi-selected:bg-[color-mix(in_srgb,var(--focus)_12%,transparent)]',
        inSplit && 'bg-selected font-medium',
        (menuOpen || moreOpen) && 'bg-hover shadow-[inset_0_0_0_1.5px_var(--focus)]',
        away && 'text-tertiary',
      )}
      data-sidebar-row=""
      data-session-id={summary.id}
      tabIndex={tabStop ? 0 : -1}
      aria-current={current ? 'page' : undefined}
      aria-expanded={hasChildren ? expanded : undefined}
      onClick={() => openSession(summary.id, summary.projectPath)}
      onDoubleClick={rename.start}
      onKeyDown={(event) => {
        // The context menu key opens the More menu, the row's menu for the keyboard.
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
    >
      {caret}
      {mark}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {node.subagents.length > 0 && !away && (
        <SubagentBadge
          parent={summary}
          subagents={node.subagents}
          onHover={(over) => {
            overBadge.current = over
            setBadgeHovered(over)
            if (over) setCardOpen(false)
          }}
        />
      )}
      {summary.pr && <PrIcon state={summary.pr.state} className="size-[13px]!" />}
      {hasChildren && !expanded && (
        <span
          aria-label={t('row.subSessions', { count: children.length })}
          className="shrink-0 text-caption font-normal text-tertiary tabular-nums"
        >
          {children.length}
        </span>
      )}
      {gone && <span className="sr-only">{gone}</span>}
      {showHost && hostName && (
        <span
          className={cn(
            'max-w-24 shrink-0 truncate text-xs font-normal text-tertiary group-hover/session:opacity-0 group-has-focus-visible/session:opacity-0 group-data-over-badge/session:opacity-100!',
            moreOpen && 'opacity-0',
          )}
        >
          {hostName}
        </span>
      )}
      {!away && (
        <SessionIndicator
          status={status}
          expiring={expiring}
          className={cn(
            'group-hover/session:opacity-0 group-has-focus-visible/session:opacity-0 group-data-over-badge/session:opacity-100!',
            moreOpen && 'opacity-0',
          )}
        />
      )}
    </SidebarMenuButton>
  )

  const menuItems = (
    <SessionMenuItems
      summary={summary}
      onRename={rename.menu.onRename}
      onNewSubSession={rename.menu.onLeave}
      onDelete={() => setDeleting(true)}
    />
  )

  return (
    <SidebarMenuItem>
      <div ref={row} data-over-badge={badgeHovered || undefined} className="group/session relative">
        {branch && <TreeLine last={branch === 'last'} />}
        {rename.renaming ? (
          <>
            {/* A field cannot sit inside the row's button, so the row is a plain box while renaming. */}
            <div
              className="flex h-row items-center gap-[9px] rounded-lg bg-surface pr-1.5 text-row text-primary shadow-[0_0_0_2px_var(--edit-ring),var(--elevation-control)]"
              style={{ paddingLeft: pad }}
            >
              {caret}
              {mark}
              <SessionTitleField
                summary={summary}
                onDone={rename.finish}
                className="h-full flex-1 bg-transparent selection:bg-edit-selection aria-invalid:text-danger"
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
              {/* A trigger's render must take its props, so the card's Root wraps the menu trigger. */}
              <HoverCard
                open={cardOpen}
                onOpenChange={(open) => setCardOpen(open && !overBadge.current)}
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
                  <SessionCard summary={summary} cache={cache} />
                </HoverCardContent>
              </HoverCard>
              <ContextMenuContent
                finalFocus={rename.menu.finalFocus}
                onKeyDown={runSessionMenuAccelerator}
              >
                {menuItems}
              </ContextMenuContent>
            </ContextMenu>
            {/* Sits over the status slot at the row's end, so the title keeps its width. */}
            <DropdownMenu
              open={moreOpen}
              onOpenChange={setMoreOpen}
              onOpenChangeComplete={rename.menu.onOpenChangeComplete}
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    <DropdownMenuTrigger
                      render={
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-label={t('row.moreFor', { title })}
                          className="absolute top-1 right-1.5 grid size-6 place-items-center rounded-md bg-selected text-primary opacity-0 outline-none transition-opacity duration-(--duration-fast) group-hover/session:opacity-100 group-has-focus-visible/session:opacity-100 group-data-over-badge/session:opacity-0! data-popup-open:opacity-100 [&_svg]:size-[15px]"
                        />
                      }
                    />
                  }
                >
                  <EllipsisIcon />
                </TooltipTrigger>
                <TooltipContent>{t('row.more')}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent
                align="start"
                finalFocus={rename.menu.finalFocus}
                onKeyDown={runSessionMenuAccelerator}
              >
                {menuItems}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
      {expanded && (
        <ul className="flex flex-col gap-0.5 pt-0.5">
          {children.map((child, i) => (
            <SessionRow
              key={child.summary.id}
              node={child}
              tabStopId={tabStopId}
              branch={i === children.length - 1 ? 'last' : 'middle'}
            />
          ))}
        </ul>
      )}
      <DeleteSessionDialog
        sessionId={summary.id}
        title={title}
        open={deleting}
        onOpenChange={setDeleting}
      />
    </SidebarMenuItem>
  )
})

/**
 * The line from a parent down along its sub-sessions, with a tick to each; on the last it turns
 * with a short curve and stops.
 */
function TreeLine({ last }: { last: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute left-[17px] w-[9px] border-l border-default',
        last
          ? 'top-[-2px] h-[19px] rounded-bl-[4px] border-b'
          : 'top-[-2px] bottom-[-2px] before:absolute before:top-[18px] before:-left-px before:w-[9px] before:border-t before:border-default',
      )}
    />
  )
}
