import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { basename } from '@renderer/lib/format'
import { hostOfPath, hostPath } from '@renderer/lib/host-paths'
import { findProjectForSession, projectFolders, useProjectsStore } from '@renderer/stores/projects'
import { Glyph } from '@renderer/features/shell/glyph'
import { NO_PROJECT_ICON } from '@renderer/features/shell/no-project-icon'
import { ProjectMark } from '@renderer/features/shell/project-icon'
import { useSessionsStore } from '@renderer/stores/sessions'
import { WORKTREE_ICON } from '../worktree/worktree-icon'
import { WorktreeHint } from '../worktree/worktree-tag'
import { HostChip } from './host-chip'

/**
 * Where the session runs, on the tray before its branch: the host and the project, shown and not
 * chosen, since both are fixed once the session starts. The project's path is in its tooltip; a
 * session in a worktree marks the project with the worktree's mark, its folder in the tooltip too.
 */
export function SessionPlace({
  sessionId,
  projectPath,
}: {
  sessionId: string
  projectPath: string
}) {
  const { t } = useTranslation('composer')
  const scratch = useSessionsStore((s) => s.byId[sessionId]?.scratch ?? false)
  const worktree = useSessionsStore((s) => s.byId[sessionId]?.worktree)
  const projectOwner = useSessionsStore((s) => s.byId[sessionId]?.projectOwner)
  const project = useProjectsStore((s) =>
    findProjectForSession(s.projects, { projectPath, projectOwner }),
  )
  const path = hostPath(projectPath)
  const folderLabel = basename(path)
  const showFolder =
    !scratch && !!project && (projectFolders(project).length > 1 || project.path !== projectPath)
  const label = scratch
    ? t('place.noProject')
    : project
      ? showFolder && folderLabel !== project.name
        ? `${project.name} · ${folderLabel}`
        : project.name
      : folderLabel

  return (
    <>
      <HostChip hostId={hostOfPath(projectPath)} />
      <Tooltip>
        <TooltipTrigger
          render={<span className="ui-as-tray-link kettu-tray-link--project" data-static="" />}
        >
          {worktree ? (
            <Glyph icon={WORKTREE_ICON} size={13} />
          ) : scratch ? (
            <Glyph icon={NO_PROJECT_ICON} size={14} />
          ) : (
            <ProjectMark icon={project?.icon} open />
          )}
          <span className="kettu-tray-link__text">{label}</span>
        </TooltipTrigger>
        <TooltipContent>
          {worktree ? (
            <span className="flex flex-col gap-1.5">
              <span className="break-all">{path}</span>
              <WorktreeHint worktree={worktree} />
            </span>
          ) : (
            path
          )}
        </TooltipContent>
      </Tooltip>
    </>
  )
}
