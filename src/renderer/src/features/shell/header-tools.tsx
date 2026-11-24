import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { IconSvgElement } from '@hugeicons/react'
import { Cancel01Icon, MoreHorizontalIcon, SidebarRightIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import type { SessionView } from '@shared/thread'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { leaveSession } from '@renderer/app/actions'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { summaryParts } from '@renderer/features/board/board-model'
import { useBoardActivity, useBoardNews } from '@renderer/features/board/use-board-activity'
import { usePane } from '@renderer/features/split/pane-context'
import {
  DeleteSessionDialog,
  SessionMenuHeader,
  SessionMenuItems,
} from '@renderer/features/sidebar/session-menu'
import { runSessionMenuAccelerator } from '@renderer/features/sidebar/session-menu-model'
import { formatShortcut, isMac, isWeb } from '@renderer/lib/platform'
import { useDevicesStore } from '@renderer/stores/devices'
import { useBrowserStore } from '@renderer/stores/browser'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { useSideChatNews } from '@renderer/stores/side-chat'
import {
  closeSplitPane,
  focusPane,
  panelSession,
  shownPanel,
  toggleSidePane,
  useViewStore,
} from '@renderer/stores/view'
import { reopenSidePanel } from './open-surfaces'
import { requestSurfaceListFocus, SURFACE_ICON } from './surface-rows'
import { SurfaceMenu } from './surface-tabs'
import { PaneIcon } from './panel-button'
import { NoDrag } from './top-bar'

/**
 * The right end of a session's top bar: the shortcuts to the Board and Files tabs, which open the
 * side panel on their tab and never fold it away, then More tools with the side panel's list, and
 * last the side panel's button while the panel is closed. Open, the panel's own row ends with
 * that button in the same place, so the bar has none. A session's More menu leads them while the
 * bar does not place it after the title itself.
 */
export function HeaderTools({
  projectPath,
  panel,
  summary,
  session,
  onRename,
  onNewSubSession,
  menu,
}: {
  projectPath: string
  /** The session's side panel, or New session's while it creates one. */
  panel: string
  /** The session the bar belongs to; with `onRename` it adds its More menu. */
  summary?: SessionSummary
  session?: SessionView
  onRename?: () => void
  onNewSubSession?: () => void
  /** The More menu's close hands the focus on, as the title field needs after Rename. */
  menu?: { finalFocus: () => boolean; onOpenChangeComplete: (open: boolean) => void }
}) {
  const sessionId = panelSession(panel)
  // A session has a board; New session has no session yet, and a sub-agent's page shows its
  // parent's work.
  const board = useSessionsStore((s) => {
    const origin = sessionId ? s.byId[sessionId]?.origin : undefined
    return origin !== undefined && origin !== 'subagent'
  })
  const ref = useRef<HTMLDivElement>(null)
  const slots = useToolSlots(ref)
  const tools = useBarTools({ panel, sessionId, board })
  const buttons = tools.slice(0, slots)
  const hidden = tools.filter((tool) => !buttons.includes(tool))
  return (
    <NoDrag ref={ref} className="kp-bar-tools">
      {summary && onRename && onNewSubSession && (
        <SessionMoreMenu
          summary={summary}
          session={session}
          onRename={onRename}
          onNewSubSession={onNewSubSession}
          menu={menu}
        />
      )}
      {buttons.map((tool) => (
        <BarButton key={tool.id} label={tool.label} pressed={tool.open} onClick={tool.onSelect}>
          <PaneIcon icon={tool.icon} size={16} />
          {tool.dot && <span aria-hidden className={dotClass(tool.dot)} />}
        </BarButton>
      ))}
      <MoreToolsMenu
        panel={panel}
        projectPath={projectPath}
        dot={
          hidden.some((tool) => tool.dot === 'needs')
            ? 'needs'
            : hidden.some((tool) => tool.dot)
              ? 'news'
              : undefined
        }
      />
      <SidePanelButton panel={panel} projectPath={projectPath} />
    </NoDrag>
  )
}

/** One of the bar's shortcuts: a tab of the side panel in common use. */
interface Tool {
  id: 'board' | 'files'
  /** The button's tooltip, with what runs in it where that matters. */
  label: string
  icon: IconSvgElement
  /** Its tab is the one the side panel shows. */
  open: boolean
  dot?: 'news' | 'needs'
  onSelect: () => void
}

/** A shortcut's button and the gap after it, and what the title takes. */
const TOOL_SLOT = 30
const BAR_RESERVE = 150

/** How many shortcuts the bar has room for beside the title, which gives way last. */
function useToolSlots(ref: RefObject<HTMLElement | null>): number {
  const [slots, setSlots] = useState(Number.POSITIVE_INFINITY)
  useLayoutEffect(() => {
    const bar = ref.current?.closest('header')
    if (!bar) return
    const measure = () => {
      const style = getComputedStyle(bar)
      const room =
        bar.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight) -
        BAR_RESERVE
      // Two of the slots go to More tools and the side panel's button.
      setSlots(Math.max(0, Math.floor(room / TOOL_SLOT) - 2))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(bar)
    return () => observer.disconnect()
  }, [ref])
  return slots
}

/** The bar's shortcuts in the order it draws them: the Board, then Files. */
function useBarTools({
  panel,
  sessionId,
  board,
}: {
  panel: string
  sessionId: string | null
  board: boolean
}): Tool[] {
  const { t } = useTranslation('shell')
  const { t: tb } = useTranslation('board')
  const context = usePane()
  const shownPane = useViewStore((s) => (shownPanel(s) === panel ? s.sidePane[panel] : undefined))
  const activity = useBoardActivity(sessionId ?? '')
  const boardNews = useBoardNews(sessionId)
  // Selects the tab, opening the panel for it; in a pane out of focus that pane takes the focus.
  const select = (id: Tool['id']) => () => {
    if (context && !context.focused) focusPane(context.paneId)
    toggleSidePane(panel, id, true)
  }
  const tools: Tool[] = []
  if (board && sessionId) {
    const parts = summaryParts(tb, activity)
    tools.push({
      id: 'board',
      label: [t('headerTools.board'), parts.running, parts.needs].filter(Boolean).join(' \u00b7 '),
      icon: SURFACE_ICON.board,
      open: shownPane === 'board',
      dot: boardNews,
      onSelect: select('board'),
    })
  }
  tools.push({
    id: 'files',
    label: t('headerTools.files'),
    icon: SURFACE_ICON.files,
    open: shownPane === 'files',
    onSelect: select('files'),
  })
  return tools
}

function dotClass(dot: 'news' | 'needs'): string {
  return dot === 'needs' ? 'kp-bar-dot kp-bar-dot--needs' : 'kp-bar-dot'
}

/**
 * More tools: the side panel's list, as its **+** shows it, then **Close pane** in a split or, on
 * a session's only pane, **Leave session**, which does what Mod+W does there: New session, with
 * the session kept and its turn running. Without a panel it holds only those, and has no button
 * where it would hold nothing.
 */
export function MoreToolsMenu({
  panel,
  projectPath,
  dot,
}: {
  panel?: string
  projectPath?: string
  /** A shortcut the bar has no room for has news. */
  dot?: 'news' | 'needs'
}) {
  const { t } = useTranslation('shell')
  const pane = usePane()
  const view = pane?.view
  const chatNews = useSideChatNews(panel ? panelSession(panel) : null)
  const leave =
    pane && !pane.split && view?.kind === 'session'
      ? () => leaveSession(useSessionsStore.getState().byId[view.sessionId])
      : null
  const list = panel !== undefined && projectPath !== undefined
  if (!list && !pane?.split && !leave) return null
  const mark = dot ?? (chatNews ? 'news' : undefined)
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <button type="button" aria-label={t('headerTools.more')} className="kp-tool" />
              }
            />
          }
        >
          <PaneIcon icon={MoreHorizontalIcon} size={16} />
          {mark && <span aria-hidden className={dotClass(mark)} />}
        </TooltipTrigger>
        <TooltipContent>{t('headerTools.more')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        className="w-68"
        onKeyDown={(event) => runSessionMenuAccelerator(event, isMac)}
      >
        {list && (
          <span
            className="contents"
            // Picking from the list in a pane out of focus brings its panel into view.
            onClickCapture={() => pane && !pane.focused && focusPane(pane.paneId)}
          >
            <SurfaceMenu panel={panel} projectPath={projectPath} />
          </span>
        )}
        {list && (pane?.split || leave) && <DropdownMenuSeparator />}
        {pane?.split ? (
          <DropdownMenuItem onClick={() => closeSplitPane(pane.paneId, pane.focused)}>
            <PaneIcon icon={Cancel01Icon} size={16} />
            {t('headerTools.closePane')}
          </DropdownMenuItem>
        ) : (
          leave && (
            <DropdownMenuItem onClick={leave}>
              <PaneIcon icon={Cancel01Icon} size={16} />
              {t('headerTools.leaveSession')}
              {/* A browser keeps Mod+W for its own tab. */}
              {!isWeb && <DropdownMenuShortcut>{formatShortcut('Mod+W')}</DropdownMenuShortcut>}
            </DropdownMenuItem>
          )
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A 28 px button of the bar, with its name on hover. */
function BarButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string
  pressed?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={pressed}
            onClick={onClick}
            className="kp-tool"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * The side panel's button at the end of the bar, in the window's top right corner, while the
 * panel is closed: it opens the tab shown last, or the side panel's list when there is none. The
 * open panel's row ends with the same button in the same place, which folds it away.
 */
function SidePanelButton({ panel, projectPath }: { panel: string; projectPath: string }) {
  const { t } = useTranslation('common')
  const context = usePane()
  const sessionId = panelSession(panel)
  const shown = useViewStore((s) => shownPanel(s) === panel && !!s.sidePane[panel])
  // An agent opened a page or a device while the panel showed something else.
  const pageNews = useBrowserStore((s) => (sessionId ? !!s.unseen[sessionId] : false))
  const deviceNews = useDevicesStore((s) => (sessionId ? !!s.unseen[sessionId] : false))
  if (shown) return null
  return (
    <BarButton
      label={t('pane.open')}
      onClick={() => {
        if (context && !context.focused) focusPane(context.paneId)
        if (reopenSidePanel(panel, projectPath)) requestSurfaceListFocus(panel)
      }}
    >
      <PaneIcon icon={SidebarRightIcon} size={16} />
      {(pageNews || deviceNews) && <span aria-hidden className="kp-bar-dot" />}
    </BarButton>
  )
}

/**
 * The session's More menu: who runs it, then what can be done with it from here, as the sidebar
 * row's menu does with what a row needs.
 */
export function SessionMoreMenu({
  summary,
  session,
  onRename,
  onNewSubSession,
  menu,
}: {
  summary: SessionSummary
  session: SessionView | undefined
  onRename: () => void
  onNewSubSession: () => void
  menu?: { finalFocus: () => boolean; onOpenChangeComplete: (open: boolean) => void }
}) {
  const { t } = useTranslation('sidebar')
  const [deleting, setDeleting] = useState(false)
  return (
    <>
      <DropdownMenu onOpenChangeComplete={menu?.onOpenChangeComplete}>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={<button type="button" aria-label={t('row.more')} className="kp-tool" />}
              />
            }
          >
            <PaneIcon icon={MoreHorizontalIcon} size={16} />
          </TooltipTrigger>
          <TooltipContent>{t('row.more')}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          align="start"
          className="w-68"
          finalFocus={menu?.finalFocus}
          onKeyDown={(event) => runSessionMenuAccelerator(event, isMac)}
        >
          <SessionMenuHeader summary={summary} session={session} />
          <SessionMenuItems
            summary={summary}
            place="more"
            onRename={onRename}
            onNewSubSession={onNewSubSession}
            onDelete={() => setDeleting(true)}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteSessionDialog
        sessionId={summary.id}
        title={sessionTitle(summary)}
        open={deleting}
        onOpenChange={setDeleting}
      />
    </>
  )
}
