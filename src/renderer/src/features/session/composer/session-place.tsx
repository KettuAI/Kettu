import { useTranslation } from 'react-i18next'
import { FolderMark } from '@renderer/components/affect/assistant-home'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { HostIcon } from '@renderer/features/settings/remote-parts'
import { basename } from '@renderer/lib/format'
import { hostOfPath, hostPath } from '@renderer/lib/host-paths'
import { isMac, isWeb, platform } from '@renderer/lib/platform'
import { useOtherHost } from '@renderer/stores/hosts'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useWebHostStore } from '@renderer/stores/web-host'

/**
 * Where the session runs, on the tray before its branch: the host and the project, shown and not
 * chosen, since both are fixed once the session starts. The project's path is in its tooltip.
 */
export function SessionPlace({
  sessionId,
  projectPath,
}: {
  sessionId: string
  projectPath: string
}) {
  const { t } = useTranslation('composer')
  const hostId = hostOfPath(projectPath)
  const other = useOtherHost(hostId)
  const web = useWebHostStore((s) => s.host)
  const scratch = useSessionsStore((s) => s.byId[sessionId]?.scratch ?? false)
  const listed = useProjectsStore((s) => s.projects.find((p) => p.path === projectPath)?.name)
  const path = hostPath(projectPath)

  // In a browser, this computer is the host that serves the page.
  const host =
    hostId !== null
      ? { name: other?.name ?? t('place.unknownHost'), platform: other?.platform ?? '' }
      : isWeb
        ? { name: web?.name ?? '', platform: web?.platform ?? '' }
        : { name: t('place.thisComputer', isMac ? { context: 'mac' } : {}), platform }

  return (
    <>
      {host.name && (
        <Tooltip>
          <TooltipTrigger
            render={<span className="ui-as-tray-link kettu-tray-link--host" data-static="" />}
          >
            <HostIcon platform={host.platform} className="size-3.5" />
            <span className="kettu-tray-link__text">{host.name}</span>
          </TooltipTrigger>
          <TooltipContent>{host.name}</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger
          render={<span className="ui-as-tray-link kettu-tray-link--project" data-static="" />}
        >
          <FolderMark />
          <span className="kettu-tray-link__text">
            {scratch ? t('place.noProject') : (listed ?? basename(path))}
          </span>
        </TooltipTrigger>
        <TooltipContent>{path}</TooltipContent>
      </Tooltip>
    </>
  )
}
