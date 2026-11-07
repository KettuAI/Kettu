import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  MoreHorizontalIcon,
  PinIcon,
  PinOffIcon,
} from '@hugeicons/core-free-icons'
import { AnimatePresence, motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { pinSession } from '@renderer/app/actions'
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
import { isMac, isMod } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { awayHosts, isAway, sidebarHosts, useOtherHost } from '@renderer/stores/hosts'
import { useProjectsStore } from '@renderer/stores/projects'
import {
  clearSelection,
  selectionFor,
  selectRange,
  toggleSelected,
  useSessionSelection,
} from '@renderer/stores/session-selection'
import {
  hostOfSession,
  sessionTitle,
  useSessionsStore,
  visibleOrder,
  type SessionNode,
} from '@renderer/stores/sessions'
import { useSessionDragSource } from '@renderer/features/split/session-drag-model'
import { allPanes, paneWithSession } from '@renderer/features/split/layout'
import { openSession, useViewStore } from '@renderer/stores/view'
import { RenameHints } from './rename-hints'
import { useRenameHints } from './rename-scope'
import { isReturning, rowVariants } from './row-exit'
import { rowStatus } from './row-status'
import { cacheGone, useGoneLabel, useSessionCache } from './session-cache'
import { SessionCard } from './session-card'
import { SessionIndicator } from './session-indicator'
import {
  DeleteSessionDialog,
  MultiSessionMenuItems,
  SessionMenuItems,
  SessionTitleField,
} from './session-menu'
import { runSessionMenuAccelerator } from './session-menu-model'
import { PrBadge } from './pr-badge'
import { SubagentBadge } from './subagent-badge'
import { useRenaming } from './use-renaming'

/**
 * A row's padding before its mark, as App Shell's chat rows: a session in a project's folder lines
 * up with the folder's name; a sub-session's row starts past its parent's tree line.
 */
const ROW_PAD = 6
const INDENT_PAD = 30
const NESTED_STEP = 22

export const SessionRow = memo(function SessionRow({
  node,
  tabStopId,
  showHost = false,
  indent = false,
  branch,
}: {
  node: SessionNode
  /** The id of the list's one Tab stop, which the row it names takes. */
  tabStopId: string | null
  /** The row ends with its host's name, as in a list across the hosts. */
  showHost?: boolean
  /** In a project's folder, so the row lines up with the folder's name. */
  indent?: boolean
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
  const picked = useSessionSelection((s) => selectionFor(summary.id, s.ids))
  // A row picked alone shows it, though its menu still acts on it alone.
  const marked = useSessionSelection((s) => s.ids.includes(summary.id))
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
  const variants = useMemo(() => rowVariants(summary.id), [summary.id])
  const [moreOpen, setMoreOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [cardOpen, setCardOpen] = useState(false)
  const row = useRef<HTMLDivElement>(null)
  const rename = useRenaming(() => row.current?.querySelector<HTMLElement>('[data-sidebar-row]'))
  const drag = useSessionDragSource(summary.id, rename.renaming)
  const ownHints = useRenameHints(rename.renaming)
  const base = indent ? INDENT_PAD : ROW_PAD
  const pad = branch ? base + NESTED_STEP : base
  const cache = useSessionCache(summary)
  const gone = useGoneLabel(cache)
  const expiring = cache?.state === 'ending' ? cache.cache : null
  // Collapsed, a parent speaks for its sub-sessions: their count and the loudest status.
  const status = rowStatus(node, hasChildren && !expanded)
  const title = sessionTitle(summary)

  // Mod-click and Shift-click pick rows for a menu that acts on all of them; a plain click opens
  // the session and lets go of the picked ones.
  const pick = (event: React.MouseEvent): boolean => {
    const currentId = useViewStore.getState().main
    const current = currentId.kind === 'session' ? currentId.sessionId : null
    if (isMod(event) && !event.shiftKey && !event.altKey) {
      toggleSelected(summary.id)
      return true
    }
    if (event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const view = useViewStore.getState()
      const order = visibleOrder(
        { ...view, hosts: sidebarHosts(), away: awayHosts() },
        useSessionsStore.getState().byId,
        useProjectsStore.getState().projects,
      )
      selectRange(summary.id, current, order)
      return true
    }
    clearSelection()
    return false
  }

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
  const mark = (
    <span className="ui-as-chat-row__logo relative">
      <AgentMark
        agent={summary.agentId}
        size={14}
        hostId={hostId}
        className={cn(
          'transition-[filter,opacity] duration-(--duration-base)',
          cacheGone(cache) && 'opacity-40 grayscale',
        )}
      />
    </span>
  )

  const button = (
    <button
      ref={drag.ref}
      type="button"
      aria-description={inSplit ? t('row.inSplitView') : undefined}
      // The other panes' rows take the current row's fill.
      className={cn(
        'ui-as-side__item ui-as-chat-row__link data-multi-selected:bg-(--row-picked)!',
        inSplit && 'kettu-row-in-view',
        away && 'text-(--faint)!',
      )}
      data-sidebar-row=""
      data-session-id={summary.id}
      tabIndex={tabStop ? 0 : -1}
      aria-current={current ? 'page' : undefined}
      aria-expanded={hasChildren ? expanded : undefined}
      data-multi-selected={marked ? '' : undefined}
      onClick={(event) => pick(event) || openSession(summary.id, summary.projectPath)}
      onDoubleClick={rename.start}
      onKeyDown={(event) => {
        if (event.key === 'Escape') clearSelection()
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
      <span className="ui-as-side__text" dir="auto">
        {title}
      </span>
      {node.subagents.length > 0 && !away && (
        <SubagentBadge
          parent={summary}
          subagents={node.subagents}
          onEnter={() => setCardOpen(false)}
        />
      )}
      <PrBadge summary={summary} onEnter={() => setCardOpen(false)} />
      {hasChildren && !expanded && (
        <span
          aria-label={t('row.subSessions', { count: children.length })}
          className="shrink-0 text-[12px] font-normal text-(--faint) tabular-nums"
        >
          {children.length}
        </span>
      )}
      {gone && <span className="sr-only">{gone}</span>}
      {showHost && hostName && (
        <span className="kettu-row-end max-w-24 shrink-0 truncate text-[12px] font-normal text-(--faint)">
          {hostName}
        </span>
      )}
      {!away && <SessionIndicator status={status} expiring={expiring} className="kettu-row-end" />}
    </button>
  )

  const menuItems = picked ? (
    <MultiSessionMenuItems ids={picked} onDelete={() => setDeleting(true)} />
  ) : (
    <SessionMenuItems
      summary={summary}
      onRename={rename.menu.onRename}
      onNewSubSession={rename.menu.onLeave}
      onDelete={() => setDeleting(true)}
    />
  )

  const pinned = !!summary.pinnedAt
  return (
    <motion.li
      className="flex flex-col"
      variants={variants}
      initial={isReturning(summary.id) ? 'hidden' : false}
      animate="shown"
      exit="exit"
    >
      <div
        ref={row}
        className="ui-as-chat-row"
        data-indent={indent || undefined}
        data-menu={menuOpen || moreOpen || undefined}
      >
        {branch && <TreeLine last={branch === 'last'} left={base + 7} />}
        {rename.renaming ? (
          <>
            {/* A field cannot sit inside the row's button, so the row is a plain box while renaming. */}
            <div
              className="ui-as-chat-row__rename flex items-center gap-2"
              style={{ paddingLeft: pad - 1 }}
            >
              {caret}
              {mark}
              <SessionTitleField
                summary={summary}
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
              {/* A trigger's render must take its props, so the card's Root wraps the menu trigger. */}
              <HoverCard
                open={cardOpen}
                // The badge lists the sub-agents on its own hover, which the row's card leaves to it.
                onOpenChange={(open) =>
                  setCardOpen(open && !row.current?.querySelector('[data-subagent-badge]:hover'))
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
                  <SessionCard summary={summary} cache={cache} />
                </HoverCardContent>
              </HoverCard>
              <ContextMenuContent
                finalFocus={rename.menu.finalFocus}
                onKeyDown={(event) => runSessionMenuAccelerator(event, isMac)}
              >
                {menuItems}
              </ContextMenuContent>
            </ContextMenu>
            {/* App Shell's row tools: the More menu and the pin, shown on hover. */}
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
                      aria-label={t('row.moreFor', { title })}
                      title={t('row.more')}
                      className="ui-as-chat-row__tool"
                    />
                  }
                >
                  <Glyph icon={MoreHorizontalIcon} size={15} />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  finalFocus={rename.menu.finalFocus}
                  onKeyDown={(event) => runSessionMenuAccelerator(event, isMac)}
                >
                  {menuItems}
                </DropdownMenuContent>
              </DropdownMenu>
              <button
                type="button"
                // One stop per row for the keyboard: pinning is also in the More menu.
                tabIndex={-1}
                aria-label={pinned ? t('row.unpin') : t('row.pin')}
                aria-pressed={pinned}
                title={pinned ? t('row.unpin') : t('row.pin')}
                onClick={() => void pinSession(summary.id, !pinned)}
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
            {children.map((child, i) => (
              <SessionRow
                key={child.summary.id}
                node={child}
                tabStopId={tabStopId}
                indent={indent}
                branch={i === children.length - 1 ? 'last' : 'middle'}
              />
            ))}
          </AnimatePresence>
        </ul>
      )}
      <DeleteSessionDialog
        sessionId={summary.id}
        title={title}
        ids={picked ?? undefined}
        open={deleting}
        onOpenChange={setDeleting}
      />
    </motion.li>
  )
})

/**
 * The line from a parent down along its sub-sessions, with a tick to each; on the last it turns
 * with a short curve and stops.
 */
function TreeLine({ last, left }: { last: boolean; left: number }) {
  return (
    <span
      aria-hidden
      style={{ left }}
      className={cn(
        'pointer-events-none absolute w-[9px] border-l border-(--line-strong)',
        last
          ? 'top-0 h-[15px] rounded-bl-[4px] border-b'
          : 'inset-y-0 before:absolute before:top-[15px] before:-left-px before:w-[9px] before:border-t before:border-(--line-strong)',
      )}
    />
  )
}
