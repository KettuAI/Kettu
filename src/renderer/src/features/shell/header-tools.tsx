import type { ReactNode } from 'react'
import { FolderIcon, SquareTerminalIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { GitStatusCluster } from '@renderer/features/git/git-status'
import { cn } from '@renderer/lib/utils'
import { useGitStore } from '@renderer/stores/git'
import { toggleSidePane, useViewStore, type SidePane } from '@renderer/stores/view'
import { NoDrag, TopBarRule } from './top-bar'

/**
 * The right end of the top bar: the project's git status and the side panel's panes. The git
 * status shrinks a thousand times faster than the session title, so in a crowded bar the branch
 * gives way first, down to its icon, and the title keeps its room.
 */
export function HeaderTools({ projectPath }: { projectPath: string }) {
  const { t } = useTranslation('shell')
  const isRepo = useGitStore((s) => !!s.status[projectPath]?.repo)
  return (
    <>
      {isRepo && (
        <NoDrag className="min-w-8 shrink-1000 overflow-clip [overflow-clip-margin:3px]">
          <GitStatusCluster projectPath={projectPath} />
        </NoDrag>
      )}
      {/* Pulled back over the bar's gap, to sit as close to the git status as before. */}
      <NoDrag className={cn('shrink-0 gap-0.5', isRepo && '-ml-2')}>
        {isRepo && <TopBarRule />}
        <PaneToggle projectPath={projectPath} pane="files" label={t('headerTools.files')}>
          <FolderIcon />
        </PaneToggle>
        <PaneToggle
          projectPath={projectPath}
          pane="terminal"
          label={t('headerTools.terminal')}
          shortcut="Ctrl+`"
        >
          <SquareTerminalIcon />
        </PaneToggle>
      </NoDrag>
    </>
  )
}

function PaneToggle({
  projectPath,
  pane,
  label,
  shortcut,
  children,
}: {
  projectPath: string
  pane: SidePane
  label: string
  shortcut?: string
  children: ReactNode
}) {
  const open = useViewStore((s) => s.sidePane[projectPath] === pane)
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="quiet"
            size="icon-compact"
            aria-label={label}
            aria-pressed={open}
            onClick={() => toggleSidePane(projectPath, pane)}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label} {shortcut && <span className="opacity-60">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  )
}
