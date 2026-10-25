import { memo, useEffect, useRef, useState } from 'react'
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CornerDownRightIcon,
  EllipsisIcon,
} from 'lucide-react'
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
import { SidebarMenuButton, SidebarMenuItem } from '@renderer/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { PrIcon } from '@renderer/features/git/pr-icon'
import { prStateText } from '@renderer/features/git/pr-text'
import { cn } from '@renderer/lib/utils'
import { sessionTitle, type SessionNode } from '@renderer/stores/sessions'
import { openSession, useViewStore } from '@renderer/stores/view'
import { CacheTip } from './cache-status'
import { cacheGone, useGoneLabel, useSessionCache } from './session-cache'
import { SessionIndicator } from './session-indicator'
import { DeleteSessionDialog, SessionMenuItems, SessionTitleField } from './session-menu'
import { runSessionMenuAccelerator } from './session-menu-model'
import { useRenaming } from './use-renaming'

/** The sidebar indents two levels at most and lists deeper sub-sessions at the second level. */
const MAX_DEPTH = 2

export const SessionRow = memo(function SessionRow({
  node,
  depth = 0,
  tabStopId,
}: {
  node: SessionNode
  depth?: number
  /** The id of the list's one Tab stop, which the row it names takes. */
  tabStopId: string | null
}) {
  const { t } = useTranslation('sidebar')
  const { summary, children } = node
  const current = useViewStore(
    (s) => s.main.kind === 'session' && s.main.sessionId === summary.id && !s.settings.open,
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
  const row = useRef<HTMLDivElement>(null)
  const rename = useRenaming(() => row.current?.querySelector<HTMLElement>('[data-sidebar-row]'))
  const pad = 26 + Math.min(depth, MAX_DEPTH) * 16
  const subagent = summary.origin === 'subagent'
  const cache = useSessionCache(summary)
  const gone = useGoneLabel(cache)
  const expiring = cache?.state === 'ending' ? cache.cache : null

  const lead = subagent ? (
    <BotIcon className="text-icon" />
  ) : (
    <span className="relative grid size-3.5 shrink-0 place-items-center">
      <AgentMark
        agent={summary.agentId}
        size={14}
        className={cn(
          'transition-[filter,opacity] duration-(--duration-base)',
          cacheGone(cache) && 'opacity-40 grayscale',
          hasChildren && 'group-hover/menu-button:opacity-0',
        )}
      />
      {hasChildren && (
        <span
          role="button"
          tabIndex={-1}
          aria-label={expanded ? t('row.collapse') : t('row.expand')}
          onClick={(event) => {
            event.stopPropagation()
            setExpanded(!expanded)
          }}
          className="absolute inset-0 grid place-items-center text-icon opacity-0 group-hover/menu-button:opacity-100"
        >
          {expanded ? (
            <ChevronDownIcon className="size-3!" />
          ) : (
            <ChevronRightIcon className="size-3!" />
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
          <span className="font-normal text-tertiary group-data-active/menu-button:text-secondary">
            {' '}
            · {summary.description}
          </span>
        )}
      </span>
      {summary.pr && <PrIcon state={summary.pr.state} size={13} />}
      {hasChildren && !expanded && (
        <span
          aria-label={t('row.subSessions', { count: children.length })}
          className="inline-flex items-center gap-0.5 text-[11.5px] text-tertiary tabular group-data-active/menu-button:text-secondary"
        >
          <CornerDownRightIcon className="size-[11px]!" />
          {children.length}
        </span>
      )}
      {gone && <span className="sr-only">{gone}</span>}
      <SessionIndicator
        summary={summary}
        permissionCount={node.permissionCount}
        running={node.running}
        expiring={expiring}
        className={cn(
          'group-hover/session:opacity-0 group-has-focus-visible/session:opacity-0',
          moreOpen && 'opacity-0',
        )}
      />
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
      <div ref={row} className="group/session relative">
        {rename.renaming ? (
          // A field cannot sit inside the row's button, so the row is a plain box while renaming.
          <SidebarMenuButton
            render={<div />}
            size="row"
            isActive={current}
            style={{ paddingLeft: pad }}
            className="bg-selected pr-2 text-primary data-active:font-medium"
          >
            {lead}
            <SessionTitleField
              summary={summary}
              onDone={rename.finish}
              className="h-full flex-1 bg-transparent aria-invalid:text-danger"
            />
          </SidebarMenuButton>
        ) : (
          <>
            <ContextMenu onOpenChangeComplete={rename.menu.onOpenChangeComplete}>
              {/*
               * A trigger's render must take its props, so the tooltip Root wraps the menu trigger.
               * It stays without content, so the row is not mounted again as the cache expires.
               */}
              <Tooltip disabled={!summary.branch && !gone && !expiring}>
                <TooltipTrigger render={<ContextMenuTrigger render={button} />} delay={700} />
                <TooltipContent side="right" className="flex-col items-start gap-0.5">
                  {summary.branch && <span className="font-mono">{summary.branch}</span>}
                  {summary.branch && summary.pr && (
                    <span className="opacity-70">
                      #{summary.pr.number} · {prStateText(summary.pr.state)}
                    </span>
                  )}
                  {expiring ? <CacheTip cache={expiring} /> : gone && <span>{gone}</span>}
                </TooltipContent>
              </Tooltip>
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
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={t('row.more')}
                    className="absolute top-1/2 right-1 grid size-5 -translate-y-1/2 place-items-center rounded-md text-icon opacity-0 outline-none transition-opacity duration-(--duration-fast) group-hover/session:opacity-100 group-has-focus-visible/session:opacity-100 hover:bg-background/60 hover:text-primary data-popup-open:opacity-100 [&_svg]:size-3.5"
                  />
                }
              >
                <EllipsisIcon />
              </DropdownMenuTrigger>
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
        <ul className="relative flex flex-col gap-px pt-px">
          <span
            aria-hidden
            className="absolute top-0 bottom-3.5 w-(--hairline) bg-border"
            style={{ left: pad + 7 }}
          />
          {children.map((child) => (
            <SessionRow
              key={child.summary.id}
              node={child}
              depth={depth + 1}
              tabStopId={tabStopId}
            />
          ))}
        </ul>
      )}
      <DeleteSessionDialog
        sessionId={summary.id}
        title={sessionTitle(summary)}
        open={deleting}
        onOpenChange={setDeleting}
      />
    </SidebarMenuItem>
  )
})
