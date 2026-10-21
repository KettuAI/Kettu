import { SquareTerminalIcon } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { GitStatusCluster } from '@renderer/features/git/git-status'
import { useGitStore } from '@renderer/stores/git'
import { toggleTerminal, useViewStore } from '@renderer/stores/view'
import { NoDrag, TopBarRule } from './top-bar'

/** The right end of the top bar: the project's git status and the terminal toggle. */
export function HeaderTools({ projectPath }: { projectPath: string }) {
  const isRepo = useGitStore((s) => !!s.status[projectPath]?.repo)
  const open = useViewStore((s) => !!s.terminalOpen[projectPath])
  return (
    <NoDrag className="gap-0.5">
      <GitStatusCluster projectPath={projectPath} />
      {isRepo && <TopBarRule />}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="quiet"
              size="icon-compact"
              aria-label="Terminal"
              aria-pressed={open}
              onClick={() => toggleTerminal(projectPath)}
            />
          }
        >
          <SquareTerminalIcon />
        </TooltipTrigger>
        <TooltipContent>
          Terminal <span className="opacity-60">Ctrl+`</span>
        </TooltipContent>
      </Tooltip>
    </NoDrag>
  )
}
