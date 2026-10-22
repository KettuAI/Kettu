import type { ReactNode } from 'react'
import { FolderTreeIcon, SquareTerminalIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { GitStatusCluster } from '@renderer/features/git/git-status'
import { useGitStore } from '@renderer/stores/git'
import { toggleSidePane, useViewStore, type SidePane } from '@renderer/stores/view'
import { NoDrag, TopBarRule } from './top-bar'

/** The right end of the top bar: the project's git status and the side panel's panes. */
export function HeaderTools({ projectPath }: { projectPath: string }) {
  const { t } = useTranslation('shell')
  const isRepo = useGitStore((s) => !!s.status[projectPath]?.repo)
  return (
    <NoDrag className="gap-0.5">
      <GitStatusCluster projectPath={projectPath} />
      {isRepo && <TopBarRule />}
      <PaneToggle projectPath={projectPath} pane="files" label={t('headerTools.files')}>
        <FolderTreeIcon />
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
