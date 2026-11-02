import { ArchiveIcon, DownloadIcon, FolderIcon, PlusIcon, SquareTerminalIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Project } from '@shared/agent-host'
import { newSession } from '@renderer/app/actions'
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from '@renderer/components/ui/dropdown-menu'
import { hostOfPath } from '@renderer/lib/host-paths'
import { fileManagerName, formatShortcut, isWeb } from '@renderer/lib/platform'
import { useTerminalAllowed } from '@renderer/stores/hosts'
import { openSettings } from '@renderer/stores/view'
import { openProjectTerminal } from './project-menu-model'

/**
 * A project's actions. A context menu is a Base UI menu, so the same items serve the project
 * row's context menu and its More button. A project whose folder is gone keeps only what needs
 * no folder.
 */
export function ProjectMenuItems({
  project,
  onImport,
}: {
  project: Project
  onImport: () => void
}) {
  const { t } = useTranslation('sidebar')
  const terminal = useTerminalAllowed(project.path)
  const gone = project.missing
  // Only this computer's folders open in its file manager.
  const revealable = !isWeb && hostOfPath(project.path) === null

  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuItem disabled={gone} onClick={() => newSession(project.path)}>
          <PlusIcon />
          {t('project.menu.newSession')}
          <DropdownMenuShortcut>{formatShortcut('Mod+N')}</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={gone} onClick={onImport}>
          <DownloadIcon />
          {t('project.importSessions')}
        </DropdownMenuItem>
        {terminal && (
          <DropdownMenuItem disabled={gone} onClick={() => void openProjectTerminal(project.path)}>
            <SquareTerminalIcon />
            {t('project.menu.openInTerminal')}
          </DropdownMenuItem>
        )}
        {revealable && (
          <DropdownMenuItem
            disabled={gone}
            onClick={() => void window.kettu.shell.showItem(project.path)}
          >
            <FolderIcon />
            {t('project.menu.showIn', { name: fileManagerName() })}
          </DropdownMenuItem>
        )}
      </DropdownMenuGroup>
      <DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => openSettings('archived')}>
          <ArchiveIcon />
          {t('project.menu.showArchived')}
        </DropdownMenuItem>
      </DropdownMenuGroup>
    </>
  )
}
