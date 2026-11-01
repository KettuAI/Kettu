import type { ReactNode } from 'react'
import { FolderIcon, GlobeIcon, SquareTerminalIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Kbd } from '@renderer/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { GitStatusCluster } from '@renderer/features/git/git-status'
import { usePane } from '@renderer/features/split/pane-context'
import { hostOfPath } from '@renderer/lib/host-paths'
import { formatShortcut, isWeb } from '@renderer/lib/platform'
import { useBrowserStore } from '@renderer/stores/browser'
import { useGitStore } from '@renderer/stores/git'
import { useSessionsStore } from '@renderer/stores/sessions'
import {
  closeSplitPane,
  focusPane,
  shownSidePane,
  toggleSidePane,
  useViewStore,
  type SidePane,
} from '@renderer/stores/view'
import { NoDrag } from './top-bar'

/**
 * The right end of the top bar: the project's git status, the side panel's panes and, in a split,
 * **Close pane**. The git status shrinks a thousand times faster than the session title, so in a
 * crowded bar the branch gives way first, down to its icon, and the title keeps its room.
 */
export function HeaderTools({ projectPath }: { projectPath: string }) {
  const { t } = useTranslation('shell')
  const pane = usePane()
  const remote = hostOfPath(projectPath) !== null
  const isRepo = useGitStore((s) => !!s.status[projectPath]?.repo)
  // An agent opened a session's page while another pane showed: a dot says to look.
  const unseen = useBrowserStore((s) => s.unseen)
  const sessions = useSessionsStore((s) => s.byId)
  const sessionId = pane?.view.kind === 'session' ? pane.view.sessionId : null
  const dot = sessionId
    ? !!unseen[sessionId]
    : Object.keys(unseen).some((id) => sessions[id]?.projectPath === projectPath)
  return (
    <>
      {isRepo && (
        <NoDrag className="min-w-8 shrink-1000 overflow-clip [overflow-clip-margin:3px]">
          <GitStatusCluster projectPath={projectPath} />
        </NoDrag>
      )}
      <NoDrag className="shrink-0 gap-0.5">
        <PaneToggle projectPath={projectPath} pane="files" label={t('headerTools.files')}>
          <FolderIcon />
        </PaneToggle>
        {/* Another host's project offers its files alone through its connection. */}
        {!remote && (
          <PaneToggle
            projectPath={projectPath}
            pane="terminal"
            label={t('headerTools.terminal')}
            shortcut="Ctrl+`"
          >
            <SquareTerminalIcon />
          </PaneToggle>
        )}
        {/* The browser runs in the desktop app; a web page has no such view. */}
        {!isWeb && !remote && (
          <PaneToggle
            projectPath={projectPath}
            pane="browser"
            label={t('headerTools.browser')}
            dot={dot}
          >
            <GlobeIcon />
          </PaneToggle>
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
  projectPath,
  pane,
  label,
  shortcut,
  dot,
  children,
}: {
  projectPath: string
  pane: SidePane
  label: string
  shortcut?: string
  /** A small `--foreground` dot: the pane has news while another one shows. */
  dot?: boolean
  children: ReactNode
}) {
  const context = usePane()
  const open = useViewStore((s) => shownSidePane(s) === pane)
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
                toggleSidePane(projectPath, pane, true)
                return
              }
              toggleSidePane(projectPath, pane)
            }}
            className="relative text-secondary"
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
            className="text-secondary"
          />
        }
      >
        <XIcon />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
