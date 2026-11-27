import {
  Archive01Icon,
  ComputerTerminal01Icon,
  Download04Icon,
  FolderEditIcon,
  FolderMinusIcon,
  FolderOpenIcon,
  GitBranchIcon,
  PencilEdit02Icon,
  PinIcon,
  PinOffIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { Project } from '@shared/agent-host'
import { newSession } from '@renderer/app/actions'
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from '@renderer/components/ui/dropdown-menu'
import { openHostSettingsItem } from '@renderer/features/settings/host-sections'
import { Glyph, MenuGlyph } from '@renderer/features/shell/glyph'
import { openWorktreeSettings } from '@renderer/features/worktrees/worktree-settings-model'
import { hostOfPath } from '@renderer/lib/host-paths'
import { fileManagerName, formatShortcut, isWeb } from '@renderer/lib/platform'
import { useGitStore } from '@renderer/stores/git'
import { useHostsStore, useTerminalAllowed } from '@renderer/stores/hosts'
import { canArchiveProject } from '@renderer/stores/projects'
import { useWebHostStore } from '@renderer/stores/web-host'
import {
  hostSupportsWorktreeSettings,
  isNoProjectMenuItemDisabled,
  isProjectMenuItemDisabled,
  noProjectMenuGroups,
  openProjectTerminal,
  projectMenuGroups,
  type NoProjectMenuItem,
  type ProjectMenuItem,
} from './project-menu-model'

/** The version reported by a remote host (or the web client's host); null on the local desktop host. */
function useProjectHostVersion(hostId: string | null): string | null {
  const other = useHostsStore((s) =>
    hostId === null ? null : (s.status?.hosts?.find((h) => h.id === hostId)?.version ?? null),
  )
  const web = useWebHostStore((s) => s.host?.version ?? null)
  if (hostId !== null) return other
  return isWeb ? web : null
}

/**
 * A project's actions. A context menu is a Base UI menu, so the same items serve the project
 * row's context menu and its More button. Both local and remote projects share the same menu
 * structure, filtered by per-action capabilities and permissions: local-only file manager actions
 * stay local, folder-dependent actions disable while `missing` or `away`, and host-level actions
 * disable while `away`.
 */
export function ProjectMenuItems({
  project,
  away,
  onEdit,
  onPin,
  onImport,
  onArchive,
  onRemove,
}: {
  project: Project
  away: boolean
  onEdit: () => void
  onPin: (pinned: boolean) => Promise<void>
  onImport: () => void
  onArchive: () => void
  onRemove: () => void
}) {
  const { t } = useTranslation('sidebar')
  const hostId = hostOfPath(project.path)
  const local = hostId === null
  const terminal = useTerminalAllowed(project.path)
  const gone = project.missing
  // Only this computer's folders open in its file manager.
  const revealable = !isWeb && local
  // Left out once the project is known not to be a Git repository.
  const git = useGitStore((s) => s.status[project.path]?.repo !== null)
  const hostVersion = useProjectHostVersion(hostId)
  const worktreeSettings = hostSupportsWorktreeSettings(hostVersion)
  const pinned = project.pinnedAt != null

  const groups = projectMenuGroups({
    revealable,
    terminal,
    git,
    worktreeSettings,
    canPin: project.pinnedAt !== undefined,
    canArchive: canArchiveProject(project),
    gone,
    away,
  })

  const renderItem = (item: ProjectMenuItem) => {
    const disabled = isProjectMenuItemDisabled(item, { gone, away })
    switch (item) {
      case 'newSession':
        return (
          <DropdownMenuItem key={item} disabled={disabled} onClick={() => newSession(project.path)}>
            <MenuGlyph icon={PencilEdit02Icon} />
            {t('project.menu.newSession')}
            <DropdownMenuShortcut>{formatShortcut('Mod+N')}</DropdownMenuShortcut>
          </DropdownMenuItem>
        )
      case 'edit':
        return (
          <DropdownMenuItem key={item} disabled={disabled} onClick={onEdit}>
            <MenuGlyph icon={FolderEditIcon} />
            {t('project.menu.edit')}
          </DropdownMenuItem>
        )
      case 'pin':
        return (
          <DropdownMenuItem key={item} disabled={disabled} onClick={() => void onPin(!pinned)}>
            <MenuGlyph icon={pinned ? PinOffIcon : PinIcon} />
            {t(pinned ? 'project.menu.unpin' : 'project.menu.pin')}
          </DropdownMenuItem>
        )
      case 'importSessions':
        return (
          <DropdownMenuItem key={item} disabled={disabled} onClick={onImport}>
            <MenuGlyph icon={Download04Icon} />
            {t('project.importSessions')}
          </DropdownMenuItem>
        )
      case 'openInTerminal':
        return (
          <DropdownMenuItem
            key={item}
            disabled={disabled}
            onClick={() => void openProjectTerminal(project.path)}
          >
            <MenuGlyph icon={ComputerTerminal01Icon} />
            {t('project.menu.openInTerminal')}
          </DropdownMenuItem>
        )
      case 'showInFileManager':
        return (
          <DropdownMenuItem
            key={item}
            disabled={disabled}
            onClick={() => void window.kettu.shell.showItem(project.path)}
          >
            <MenuGlyph icon={FolderOpenIcon} />
            {t('project.menu.showIn', { name: fileManagerName() })}
          </DropdownMenuItem>
        )
      case 'worktreeSettings':
        return (
          <DropdownMenuItem
            key={item}
            disabled={disabled}
            onClick={() => openWorktreeSettings(project)}
          >
            <MenuGlyph icon={GitBranchIcon} />
            {t('project.menu.worktreeSettings')}
          </DropdownMenuItem>
        )
      case 'showArchived':
        return (
          <DropdownMenuItem
            key={item}
            disabled={disabled}
            onClick={() => openHostSettingsItem(hostId, 'archived', null)}
          >
            <MenuGlyph icon={Archive01Icon} />
            {t('project.menu.showArchived')}
          </DropdownMenuItem>
        )
      case 'archive':
        return (
          <DropdownMenuItem key={item} disabled={disabled} onClick={onArchive}>
            <MenuGlyph icon={Archive01Icon} />
            {t('project.menu.archive')}
          </DropdownMenuItem>
        )
      case 'remove':
        return (
          <DropdownMenuItem key={item} variant="destructive" disabled={disabled} onClick={onRemove}>
            <Glyph icon={FolderMinusIcon} size={15} />
            {t('project.menu.remove')}
          </DropdownMenuItem>
        )
    }
  }

  return (
    <>
      {groups.map((group, index) => (
        <DropdownMenuGroup key={group[0]}>
          {index > 0 && <DropdownMenuSeparator />}
          {group.map(renderItem)}
        </DropdownMenuGroup>
      ))}
    </>
  )
}

/**
 * No project's actions: only what fits a group of scratch folders, which is no folder itself.
 * `pinned` is undefined on a host that cannot pin it.
 */
export function NoProjectMenuItems({
  hostId,
  pinned,
  away,
  onPin,
}: {
  hostId: string | null
  pinned: boolean | undefined
  away: boolean
  onPin: (pinned: boolean) => Promise<void>
}) {
  const { t } = useTranslation('sidebar')
  const groups = noProjectMenuGroups({
    local: hostId === null,
    canPin: pinned !== undefined,
    away,
  })

  const renderItem = (item: NoProjectMenuItem) => {
    const disabled = isNoProjectMenuItemDisabled(item, { away })
    switch (item) {
      case 'newSession':
        return (
          <DropdownMenuItem key={item} disabled={disabled} onClick={() => newSession(null, true)}>
            <MenuGlyph icon={PencilEdit02Icon} />
            {t('project.menu.newSession')}
            <DropdownMenuShortcut>{formatShortcut('Mod+N')}</DropdownMenuShortcut>
          </DropdownMenuItem>
        )
      case 'pin':
        return (
          <DropdownMenuItem key={item} disabled={disabled} onClick={() => void onPin(!pinned)}>
            <MenuGlyph icon={pinned ? PinOffIcon : PinIcon} />
            {t(pinned ? 'project.menu.unpinNoProject' : 'project.menu.pinNoProject')}
          </DropdownMenuItem>
        )
      case 'showArchived':
        return (
          <DropdownMenuItem
            key={item}
            disabled={disabled}
            onClick={() => openHostSettingsItem(hostId, 'archived', null)}
          >
            <MenuGlyph icon={Archive01Icon} />
            {t('project.menu.showArchived')}
          </DropdownMenuItem>
        )
    }
  }

  return (
    <>
      {groups.map((group, index) => (
        <DropdownMenuGroup key={group[0]}>
          {index > 0 && <DropdownMenuSeparator />}
          {group.map(renderItem)}
        </DropdownMenuGroup>
      ))}
    </>
  )
}
