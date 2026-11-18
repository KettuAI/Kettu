import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { IconSvgElement } from '@hugeicons/react'
import {
  BubbleChatQuestionIcon,
  Cancel01Icon,
  ComputerIcon,
  ComputerTerminal01Icon,
  DashboardSquare02Icon,
  File01Icon,
  Globe02Icon,
  MoreHorizontalIcon,
  SidebarRightIcon,
  SmartPhone01Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import type { SessionView } from '@shared/thread'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { leaveSession } from '@renderer/app/actions'
import { Kbd } from '@renderer/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { summaryParts } from '@renderer/features/board/board-model'
import { useBoardActivity } from '@renderer/features/board/use-board-activity'
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
import { useTerminalAllowed } from '@renderer/stores/hosts'
import { hostOfSession, sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import {
  closeSplitPane,
  focusPane,
  panelSession,
  shownPanel,
  toggleBoard,
  toggleSideChat,
  toggleSidePane,
  useViewStore,
  type SidePane,
} from '@renderer/stores/view'
import { openSideChat, useSideChatNews } from '@renderer/stores/side-chat'
import { usePhoneWindow } from './narrow'
import { PaneIcon } from './panel-button'
import { NoDrag } from './top-bar'

type Pane = Exclude<SidePane, 'artifact'>

// The pane each panel showed last, which the side panel button opens again.
const lastPanes = new Map<string, Pane>()
let tracking = false
function trackLastPanes(): void {
  if (tracking) return
  tracking = true
  const record = (panes: Record<string, SidePane>) => {
    for (const [panel, pane] of Object.entries(panes))
      if (pane !== 'artifact') lastPanes.set(panel, pane)
  }
  record(useViewStore.getState().sidePane)
  useViewStore.subscribe((state, previous) => {
    if (state.sidePane !== previous.sidePane) record(state.sidePane)
  })
}

/**
 * The right end of the top bar: the buttons of the side panes in common use, which open a pane or
 * fold it away when it already shows, then the side panel button while none shows and a More menu.
 * A pane that is in use or has news keeps its button; the others, and **Leave session** or **Close
 * pane**, wait in the More menu. A session's More menu leads them while the bar does not place it
 * after the title itself.
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
  const terminal = useTerminalAllowed(projectPath)
  const sessionId = panelSession(panel)
  // A session has a board; New session has no session yet, and a sub-agent's page shows its
  // parent's work.
  const board = useSessionsStore((s) => {
    const origin = sessionId ? s.byId[sessionId]?.origin : undefined
    return origin !== undefined && origin !== 'subagent'
  })
  // An agent opened the session's page while another pane showed: a dot says to look.
  const dot = useBrowserStore((s) => (sessionId ? !!s.unseen[sessionId] : false))
  const deviceDot = useDevicesStore((s) => (sessionId ? !!s.unseen[sessionId] : false))
  // The session holds a device: its pane is in use, not just possible.
  const deviceHeld = useDevicesStore(
    (s) => !!sessionId && s.devices.some((device) => device.sessionId === sessionId),
  )
  // Hidden only once the host says it can run no device and the session holds none.
  const devices = useDevicesStore(
    (s) => !s.environment || s.environment.ios || s.environment.android || deviceHeld,
  )
  // The browser runs in the desktop app, for another host's agents too; a web page has no such
  // view. A session has one, so a session still being created does not.
  const browser = !isWeb && !!sessionId
  // The window an agent uses shows only on the computer whose apps it uses, while it uses them.
  const computer = !isWeb && !!session?.computer && !!summary && hostOfSession(summary) === null
  const available: Pane[] = [
    ...(computer ? (['computer'] as const) : []),
    ...(terminal ? (['terminal'] as const) : []),
    ...(browser ? (['browser'] as const) : []),
    ...(sessionId && devices ? (['devices'] as const) : []),
    'files',
  ]
  const phone = usePhoneWindow()
  const more =
    summary && onRename && onNewSubSession ? (
      <SessionMoreMenu
        summary={summary}
        session={session}
        onRename={onRename}
        onNewSubSession={onNewSubSession}
        menu={menu}
      />
    ) : null
  if (phone) {
    return (
      <NoDrag className="kp-bar-tools">
        {more}
        <PhonePanelMenu
          panel={panel}
          sessionId={board ? sessionId : null}
          panes={available.filter((pane) => pane !== 'computer' && pane !== 'browser')}
          dot={dot || deviceDot}
        />
      </NoDrag>
    )
  }
  return (
    <DesktopTools
      panel={panel}
      sessionId={sessionId}
      board={board}
      available={available}
      news={{ browser: dot, devices: deviceDot }}
      deviceHeld={deviceHeld}
    >
      {more}
    </DesktopTools>
  )
}

/** One of the bar's tools: a side pane, the board or the side chat. */
interface Tool {
  id: 'board' | 'sideChat' | Pane
  /** The button's tooltip, with what runs in it where that matters. */
  label: string
  /** The name in the More menu. */
  name: string
  shortcut?: string
  icon: IconSvgElement
  /** Shown now: its pane is the side panel's, or its column is open. */
  open: boolean
  dot?: 'news' | 'needs'
  /** In common use: it has a button unless the bar is too narrow. */
  common: boolean
  /** In use or with news: it keeps its button over the common ones. */
  pinned: boolean
  /** The order the bar keeps buttons in when it has room for only some, first kept. */
  rank: number
  onSelect: () => void
}

/** A tool's button and the gap after it, and what the title, the More menu and the panel button take. */
const TOOL_SLOT = 30
const BAR_RESERVE = 150

/** How many tool buttons the bar has room for beside the title, which gives way last. */
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
      // Two of the slots go to the side panel button and the More menu.
      setSlots(Math.max(0, Math.floor(room / TOOL_SLOT) - 2))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(bar)
    return () => observer.disconnect()
  }, [ref])
  return slots
}

/** The bar's tools in the order it draws them: the board, side chat and the panes. */
function useBarTools({
  panel,
  sessionId,
  board,
  available,
  news,
  deviceHeld,
}: {
  panel: string
  sessionId: string | null
  board: boolean
  available: Pane[]
  news: { browser: boolean; devices: boolean }
  deviceHeld: boolean
}): Tool[] {
  const { t } = useTranslation('shell')
  const { t: tb } = useTranslation('board')
  const context = usePane()
  const shownPane = useViewStore((s) => (shownPanel(s) === panel ? s.sidePane[panel] : undefined))
  const boardOpen = useViewStore((s) => (sessionId ? !!s.boardOpen[sessionId] : false))
  const chatOpen = useViewStore((s) => (sessionId ? !!s.sideChatOpen[sessionId] : false))
  const activity = useBoardActivity(sessionId ?? '')
  const busy = activity.running + activity.needs > 0
  const chatNews = useSideChatNews(sessionId)
  const tools: Tool[] = []
  // In a pane out of focus a button shows its tool there and never closes it.
  const outOfFocus = !!context && !context.focused
  if (board && sessionId) {
    const parts = summaryParts(tb, activity)
    tools.push({
      id: 'board',
      label: [t('headerTools.board'), parts.running, parts.needs].filter(Boolean).join(' · '),
      name: t('headerTools.board'),
      icon: DashboardSquare02Icon,
      open: boardOpen,
      dot: !boardOpen && busy ? (activity.needs > 0 ? 'needs' : 'news') : undefined,
      common: true,
      pinned: boardOpen || busy,
      rank: 4,
      onSelect: () => {
        if (outOfFocus) {
          focusPane(context.paneId)
          toggleBoard(sessionId, true)
          return
        }
        toggleBoard(sessionId)
      },
    })
    tools.push({
      id: 'sideChat',
      label: chatNews
        ? `${t('headerTools.sideChat')} \u00b7 ${t('headerTools.sideChatNews')}`
        : t('headerTools.sideChat'),
      name: t('headerTools.sideChat'),
      shortcut: 'Mod+J',
      icon: BubbleChatQuestionIcon,
      open: chatOpen,
      dot: chatNews ? 'news' : undefined,
      common: false,
      pinned: chatOpen || chatNews,
      rank: 7,
      onSelect: () => {
        if (outOfFocus) focusPane(context.paneId)
        if (chatOpen && !outOfFocus) toggleSideChat(sessionId, false)
        else openSideChat(sessionId)
      },
    })
  }
  const pane = (
    id: Pane,
    label: string,
    icon: IconSvgElement,
    rank: number,
    options: { shortcut?: string; common: boolean; dot?: boolean; held?: boolean },
  ): void => {
    if (!available.includes(id)) return
    const open = shownPane === id
    tools.push({
      id,
      label,
      name: label,
      shortcut: options.shortcut,
      icon,
      open,
      dot: options.dot && !open ? 'news' : undefined,
      common: options.common,
      pinned: open || !!options.dot || !!options.held,
      rank,
      onSelect: () => {
        if (outOfFocus) {
          focusPane(context.paneId)
          toggleSidePane(panel, id, true)
          return
        }
        toggleSidePane(panel, id)
      },
    })
  }
  // The computer's window exists only while an agent uses the computer, so it is always in use.
  pane('computer', t('headerTools.computer'), ComputerIcon, 6, { common: false, held: true })
  // Another host's terminal opens only while its owner allows devices it.
  pane('terminal', t('headerTools.terminal'), ComputerTerminal01Icon, 2, {
    shortcut: 'Ctrl+`',
    common: true,
  })
  pane('browser', t('headerTools.browser'), Globe02Icon, 3, { common: true, dot: news.browser })
  pane('devices', t('headerTools.devices'), SmartPhone01Icon, 5, {
    common: false,
    dot: news.devices,
    held: deviceHeld,
  })
  pane('files', t('headerTools.files'), File01Icon, 1, { common: true })
  const order: Tool['id'][] = [
    'board',
    'sideChat',
    'computer',
    'terminal',
    'browser',
    'devices',
    'files',
  ]
  return tools.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
}

/** The tools that keep a button: the common ones and those in use, the most useful if few fit. */
function toolsWithButtons(tools: Tool[], slots: number): Tool[] {
  const wanted = tools.filter((tool) => tool.common || tool.pinned)
  if (wanted.length <= slots) return wanted
  const kept = new Set(
    [...wanted]
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.rank - b.rank)
      .slice(0, slots),
  )
  return wanted.filter((tool) => kept.has(tool))
}

/** The desktop bar's right end: the tools with a button, the side panel button and the More menu. */
function DesktopTools({
  panel,
  sessionId,
  board,
  available,
  news,
  deviceHeld,
  children,
}: {
  panel: string
  sessionId: string | null
  board: boolean
  available: Pane[]
  news: { browser: boolean; devices: boolean }
  deviceHeld: boolean
  /** The session's More menu, which leads the bar's own. */
  children?: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const slots = useToolSlots(ref)
  const tools = useBarTools({ panel, sessionId, board, available, news, deviceHeld })
  const buttons = toolsWithButtons(tools, slots)
  return (
    <NoDrag ref={ref} className="kp-bar-tools">
      {children}
      {buttons.map((tool) => (
        <BarButton
          key={tool.id}
          label={tool.label}
          shortcut={tool.shortcut}
          pressed={tool.open}
          onClick={tool.onSelect}
        >
          <PaneIcon icon={tool.icon} size={16} />
          {tool.dot && <span aria-hidden className={dotClass(tool.dot)} />}
        </BarButton>
      ))}
      <SidePanelButton panel={panel} available={available} />
      <MoreToolsMenu tools={tools.filter((tool) => !buttons.includes(tool))} />
    </NoDrag>
  )
}

function dotClass(dot: 'news' | 'needs'): string {
  return dot === 'needs' ? 'kp-bar-dot kp-bar-dot--needs' : 'kp-bar-dot'
}

const PANE_ITEMS = {
  terminal: { icon: ComputerTerminal01Icon, label: 'headerTools.terminal' },
  devices: { icon: SmartPhone01Icon, label: 'headerTools.devices' },
  files: { icon: File01Icon, label: 'headerTools.files' },
} as const

/**
 * A phone's one button for what the bar's buttons open beside the thread, each over the whole
 * screen there, with Leave session or Close pane after them.
 */
function PhonePanelMenu({
  panel,
  sessionId,
  panes,
  dot,
}: {
  panel: string
  /** The session whose board and side chat it opens, or null where there are none. */
  sessionId: string | null
  panes: Pane[]
  /** A pane has news. */
  dot: boolean
}) {
  const { t } = useTranslation('shell')
  const { t: tc } = useTranslation('common')
  const pane = usePane()
  const shownPane = useViewStore((s) => (shownPanel(s) === panel ? s.sidePane[panel] : undefined))
  const boardOpen = useViewStore((s) => (sessionId ? !!s.boardOpen[sessionId] : false))
  const chatOpen = useViewStore((s) => (sessionId ? !!s.sideChatOpen[sessionId] : false))
  const activity = useBoardActivity(sessionId ?? '')
  const busy = !!sessionId && !boardOpen && activity.running + activity.needs > 0
  const chatNews = useSideChatNews(sessionId)
  const view = pane?.view
  const leave =
    pane && !pane.split && view?.kind === 'session'
      ? () => leaveSession(useSessionsStore.getState().byId[view.sessionId])
      : null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<button type="button" aria-label={tc('pane.open')} className="kp-tool" />}
      >
        <PaneIcon icon={SidebarRightIcon} size={18} />
        {(dot || busy || chatNews) && (
          <span
            aria-hidden
            className={activity.needs > 0 ? 'kp-bar-dot kp-bar-dot--needs' : 'kp-bar-dot'}
          />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {sessionId && (
          <>
            <DropdownMenuCheckboxItem
              closeOnClick
              checked={boardOpen}
              onCheckedChange={(open) => toggleBoard(sessionId, open)}
            >
              <PaneIcon icon={DashboardSquare02Icon} size={16} />
              {t('headerTools.board')}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              closeOnClick
              checked={chatOpen}
              onCheckedChange={(open) =>
                open ? openSideChat(sessionId) : toggleSideChat(sessionId, false)
              }
            >
              <PaneIcon icon={BubbleChatQuestionIcon} size={16} />
              {t('headerTools.sideChat')}
            </DropdownMenuCheckboxItem>
          </>
        )}
        {panes.map((id) => {
          if (!(id in PANE_ITEMS)) return null
          const item = PANE_ITEMS[id as keyof typeof PANE_ITEMS]
          return (
            <DropdownMenuCheckboxItem
              closeOnClick
              key={id}
              checked={shownPane === id}
              onCheckedChange={(open) => toggleSidePane(panel, id, open)}
            >
              <PaneIcon icon={item.icon} size={16} />
              {t(item.label)}
            </DropdownMenuCheckboxItem>
          )
        })}
        {(leave || pane?.split) && <DropdownMenuSeparator />}
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
            </DropdownMenuItem>
          )
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The More menu: the tools without a button, then **Close pane** in a split or, on a session's
 * only pane, **Leave session**, which does what Mod+W does there: New session, with the session
 * kept and its turn running. It has no button where it would hold nothing.
 */
export function MoreToolsMenu({ tools = [] }: { tools?: Tool[] }) {
  const { t } = useTranslation('shell')
  const pane = usePane()
  const view = pane?.view
  const leave =
    pane && !pane.split && view?.kind === 'session'
      ? () => leaveSession(useSessionsStore.getState().byId[view.sessionId])
      : null
  if (tools.length === 0 && !pane?.split && !leave) return null
  const dot = tools.some((tool) => tool.dot === 'needs')
    ? 'needs'
    : tools.some((tool) => tool.dot)
      ? 'news'
      : undefined
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
          {dot && <span aria-hidden className={dotClass(dot)} />}
        </TooltipTrigger>
        <TooltipContent>{t('headerTools.more')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-56">
        {tools.map((tool) => (
          <DropdownMenuCheckboxItem
            closeOnClick
            key={tool.id}
            checked={tool.open}
            onCheckedChange={tool.onSelect}
          >
            <PaneIcon icon={tool.icon} size={16} />
            {tool.name}
            {tool.shortcut && (
              <DropdownMenuShortcut>{formatShortcut(tool.shortcut)}</DropdownMenuShortcut>
            )}
          </DropdownMenuCheckboxItem>
        ))}
        {tools.length > 0 && (pane?.split || leave) && <DropdownMenuSeparator />}
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

/** A 28 px button of the bar, with its name and shortcut on hover. */
function BarButton({
  label,
  shortcut,
  pressed,
  onClick,
  children,
}: {
  label: string
  shortcut?: string
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
      <TooltipContent>
        {label}
        {shortcut && <Kbd>{formatShortcut(shortcut)}</Kbd>}
      </TooltipContent>
    </Tooltip>
  )
}

/** While the panel shows nothing, it opens again on the pane it showed last. */
function SidePanelButton({ panel, available }: { panel: string; available: Pane[] }) {
  const { t } = useTranslation('common')
  const context = usePane()
  trackLastPanes()
  const shown = useViewStore((s) => shownPanel(s) === panel && !!s.sidePane[panel])
  if (shown) return null
  const last = lastPanes.get(panel)
  const pane = last && available.includes(last) ? last : 'files'
  return (
    <BarButton
      label={t('pane.open')}
      onClick={() => {
        if (context && !context.focused) focusPane(context.paneId)
        toggleSidePane(panel, pane, true)
      }}
    >
      <PaneIcon icon={SidebarRightIcon} size={16} />
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
