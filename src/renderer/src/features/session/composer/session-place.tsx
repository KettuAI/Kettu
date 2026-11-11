import { useTranslation } from 'react-i18next'
import { FolderMark } from '@renderer/components/affect/assistant-home'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { basename } from '@renderer/lib/format'
import { hostOfPath, hostPath } from '@renderer/lib/host-paths'
import { useProjectsStore } from '@renderer/stores/projects'
import { Glyph } from '@renderer/features/shell/glyph'
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
  const listed = useProjectsStore((s) => s.projects.find((p) => p.path === projectPath)?.name)
  const path = hostPath(projectPath)

  return (
    <>
      <HostChip hostId={hostOfPath(projectPath)} />
      <Tooltip>
        <TooltipTrigger
          render={<span className="ui-as-tray-link kettu-tray-link--project" data-static="" />}
        >
          {worktree ? <Glyph icon={WORKTREE_ICON} size={13} /> : <FolderMark />}
          <span className="kettu-tray-link__text">
            {scratch ? t('place.noProject') : (listed ?? basename(path))}
          </span>
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
