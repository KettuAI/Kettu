import { useState, type ReactNode } from 'react'
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
import { openSideChat } from '@renderer/stores/side-chat'
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
 * The right end of the top bar: a button for each of the bar's side panes, which opens that pane
 * or folds it away when it already shows, then the side panel button while none shows. A session's
 * More menu leads them while the bar does not place it after the title itself, and in a split
 * **Close pane** ends them.
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
  const { t } = useTranslation('shell')
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
  // Hidden only once the host says it can run no device and the session holds none.
  const devices = useDevicesStore(
    (s) =>
      !s.environment ||
      s.environment.ios ||
      s.environment.android ||
      (!!sessionId && s.devices.some((device) => device.sessionId === sessionId)),
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
  if (phone) {
    return (
      <NoDrag className="kp-bar-tools">
        {summary && onRename && onNewSubSession && (
          <SessionMoreMenu
            summary={summary}
            session={session}
            onRename={onRename}
            onNewSubSession={onNewSubSession}
            menu={menu}
          />
        )}
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
    <NoDrag className="kp-bar-tools">
      {summary && onRename && onNewSubSession && (
        <SessionMoreMenu
          summary={summary}
          session={session}
          onRename={onRename}
          onNewSubSession={onNewSubSession}
          menu={menu}
        />
      )}
      {board && sessionId && <BoardToggle sessionId={sessionId} />}
      {board && sessionId && <SideChatToggle sessionId={sessionId} />}
      {computer && (
        <PaneToggle
          panel={panel}
          pane="computer"
          label={t('headerTools.computer')}
          icon={ComputerIcon}
        />
      )}
      {/* Another host's terminal opens only while its owner allows devices it. */}
      {terminal && (
        <PaneToggle
          panel={panel}
          pane="terminal"
          label={t('headerTools.terminal')}
          shortcut="Ctrl+`"
          icon={ComputerTerminal01Icon}
        />
      )}
      {browser && (
        <PaneToggle
          panel={panel}
          pane="browser"
          label={t('headerTools.browser')}
          dot={dot}
          icon={Globe02Icon}
        />
      )}
      {sessionId && devices && (
        <PaneToggle
          panel={panel}
          pane="devices"
          label={t('headerTools.devices')}
          dot={deviceDot}
          icon={SmartPhone01Icon}
        />
      )}
      <PaneToggle panel={panel} pane="files" label={t('headerTools.files')} icon={File01Icon} />
      <SidePanelButton panel={panel} available={available} />
      <ClosePaneButton />
    </NoDrag>
  )
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
        {(dot || busy) && (
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
 * **Close pane** in a split. A session's only pane has **Leave session** in its place, which does
 * what Mod+W does there: New session, with the session kept and its turn running.
 */
export function ClosePaneButton() {
  const { t } = useTranslation('shell')
  const pane = usePane()
  if (!pane) return null
  if (pane.split) {
    return (
      <BarButton
        label={t('headerTools.closePane')}
        onClick={() => closeSplitPane(pane.paneId, pane.focused)}
      >
        <PaneIcon icon={Cancel01Icon} size={15} />
      </BarButton>
    )
  }
  const { view } = pane
  if (view.kind !== 'session') return null
  return (
    <BarButton
      label={t('headerTools.leaveSession')}
      // A browser keeps Mod+W for its own tab.
      shortcut={isWeb ? undefined : 'Mod+W'}
      onClick={() => leaveSession(useSessionsStore.getState().byId[view.sessionId])}
    >
      <PaneIcon icon={Cancel01Icon} size={15} />
    </BarButton>
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

/** The board at the right of the session's thread, with a dot while something runs in it. */
function BoardToggle({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('shell')
  const { t: tb } = useTranslation('board')
  const context = usePane()
  const open = useViewStore((s) => !!s.boardOpen[sessionId])
  const activity = useBoardActivity(sessionId)
  const parts = summaryParts(tb, activity)
  const label = [t('headerTools.board'), parts.running, parts.needs].filter(Boolean).join(' · ')
  return (
    <BarButton
      label={label}
      pressed={open}
      onClick={() => {
        // In a pane out of focus the toggle shows the board there and never closes it.
        if (context && !context.focused) {
          focusPane(context.paneId)
          toggleBoard(sessionId, true)
          return
        }
        toggleBoard(sessionId)
      }}
    >
      <PaneIcon icon={DashboardSquare02Icon} size={16} />
      {!open && activity.running + activity.needs > 0 && (
        <span
          aria-hidden
          className={activity.needs > 0 ? 'kp-bar-dot kp-bar-dot--needs' : 'kp-bar-dot'}
        />
      )}
    </BarButton>
  )
}

/** The side chat, which takes the board's place at the right of the thread. */
function SideChatToggle({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('shell')
  const context = usePane()
  const open = useViewStore((s) => !!s.sideChatOpen[sessionId])
  return (
    <BarButton
      label={t('headerTools.sideChat')}
      shortcut="Mod+J"
      pressed={open}
      onClick={() => {
        if (context && !context.focused) focusPane(context.paneId)
        if (open && (!context || context.focused)) toggleSideChat(sessionId, false)
        else openSideChat(sessionId)
      }}
    >
      <PaneIcon icon={BubbleChatQuestionIcon} size={16} />
    </BarButton>
  )
}

function PaneToggle({
  panel,
  pane,
  label,
  shortcut,
  dot,
  icon,
}: {
  panel: string
  pane: Pane
  label: string
  shortcut?: string
  /** The pane has news while another one shows. */
  dot?: boolean
  icon: IconSvgElement
}) {
  const context = usePane()
  const open = useViewStore((s) => shownPanel(s) === panel && s.sidePane[panel] === pane)
  return (
    <BarButton
      label={label}
      shortcut={shortcut}
      pressed={open}
      onClick={() => {
        // In a pane out of focus the toggle shows its pane there and never closes the panel.
        if (context && !context.focused) {
          focusPane(context.paneId)
          toggleSidePane(panel, pane, true)
          return
        }
        toggleSidePane(panel, pane)
      }}
    >
      <PaneIcon icon={icon} size={16} />
      {dot && !open && <span aria-hidden className="kp-bar-dot" />}
    </BarButton>
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
