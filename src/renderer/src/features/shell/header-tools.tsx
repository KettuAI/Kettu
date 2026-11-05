import { useState, type ReactNode } from 'react'
import {
  EllipsisIcon,
  FolderIcon,
  GlobeIcon,
  SquareTerminalIcon,
  XIcon,
  SmartphoneIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import type { SessionView } from '@shared/thread'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Kbd } from '@renderer/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
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
import { sessionTitle } from '@renderer/stores/sessions'
import {
  closeSplitPane,
  focusPane,
  panelSession,
  shownPanel,
  toggleSidePane,
  useViewStore,
  type SidePane,
} from '@renderer/stores/view'
import { NoDrag } from './top-bar'

/** A top-bar tool: 30 px, its 17 px icon in the icon color, filled while its pane shows. */
const TOOL =
  'relative size-7.5 text-secondary aria-expanded:bg-pressed aria-expanded:text-foreground aria-pressed:shadow-none [&_svg:not([class*=size-])]:size-4.25'

/**
 * The right end of the top bar: the project's git status, the toggles of the bar's own side panel,
 * a session's More menu and, in a split, **Close pane**. The git status shrinks a thousand times faster than the
 * session title, so in a crowded bar the branch gives way first, down to its icon, and the title
 * keeps its room.
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
  /** The session the bar belongs to, which adds its More menu. */
  summary?: SessionSummary
  session?: SessionView
  onRename?: () => void
  onNewSubSession?: () => void
  /** The More menu's close hands the focus on, as the title field needs after Rename. */
  menu?: { finalFocus: () => boolean; onOpenChangeComplete: (open: boolean) => void }
}) {
  const { t } = useTranslation('shell')
  const pane = usePane()
  const terminal = useTerminalAllowed(projectPath)
  const sessionId = panelSession(panel)
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
  return (
    <>
      <NoDrag className="shrink-0 gap-2">
        {/* Another host's terminal opens only while its owner allows devices it. */}
        {terminal && (
          <PaneToggle
            panel={panel}
            pane="terminal"
            label={t('headerTools.terminal')}
            shortcut="Ctrl+`"
          >
            <SquareTerminalIcon />
          </PaneToggle>
        )}
        {/* The browser runs in the desktop app, for another host's agents too; a web page has
            no such view. A session has one, so a session still being created does not. */}
        {!isWeb && sessionId && (
          <PaneToggle panel={panel} pane="browser" label={t('headerTools.browser')} dot={dot}>
            <GlobeIcon />
          </PaneToggle>
        )}
        {sessionId && devices && (
          <PaneToggle panel={panel} pane="devices" label={t('headerTools.devices')} dot={deviceDot}>
            <SmartphoneIcon />
          </PaneToggle>
        )}
        <PaneToggle panel={panel} pane="files" label={t('headerTools.files')}>
          <FolderIcon />
        </PaneToggle>
        {summary && onRename && onNewSubSession && (
          <MoreMenu
            summary={summary}
            session={session}
            onRename={onRename}
            onNewSubSession={onNewSubSession}
            menu={menu}
          />
        )}
        {pane?.split && (
          <ClosePaneButton
            paneId={pane.paneId}
            focused={pane.focused}
            label={t('headerTools.closePane')}
          />
        )}
      </NoDrag>
    </>
  )
}

function PaneToggle({
  panel,
  pane,
  label,
  shortcut,
  dot,
  children,
}: {
  panel: string
  pane: SidePane
  label: string
  shortcut?: string
  /** A small `--foreground` dot: the pane has news while another one shows. */
  dot?: boolean
  children: ReactNode
}) {
  const context = usePane()
  const open = useViewStore((s) => shownPanel(s) === panel && s.sidePane[panel] === pane)
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="quiet"
            size="icon-compact"
            aria-label={label}
            aria-pressed={open}
            onClick={() => {
              // In a pane out of focus the toggle shows its pane there and never closes the panel.
              if (context && !context.focused) {
                focusPane(context.paneId)
                toggleSidePane(panel, pane, true)
                return
              }
              toggleSidePane(panel, pane)
            }}
            className={TOOL}
          />
        }
      >
        {children}
        {dot && !open && (
          <span
            aria-hidden
            className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-foreground"
          />
        )}
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <Kbd>{formatShortcut(shortcut)}</Kbd>}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * The session's More menu: who runs it, then what can be done with it from here, as the sidebar
 * row's menu does with what a row needs.
 */
function MoreMenu({
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
                render={
                  <Button
                    variant="quiet"
                    size="icon-compact"
                    aria-label={t('row.more')}
                    className={TOOL}
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
          align="end"
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

/** Closes the pane, leaving its session running; its composer takes the keyboard focus. */
function ClosePaneButton({
  paneId,
  focused,
  label,
}: {
  paneId: string
  focused: boolean
  label: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="quiet"
            size="icon-compact"
            aria-label={label}
            onClick={() => closeSplitPane(paneId, focused)}
            className={TOOL}
          />
        }
      >
        <XIcon />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
