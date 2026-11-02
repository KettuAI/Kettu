import { EyeIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SessionViewer } from '@shared/agent-host'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useHostLabel } from '@renderer/features/sidebar/host-label'
import { hostOfPath } from '@renderer/lib/host-paths'
import { isWeb } from '@renderer/lib/platform'
import { useOtherHost } from '@renderer/stores/hosts'
import { useViewersStore, viewerNames } from '@renderer/stores/viewers'
import { useWebHostStore } from '@renderer/stores/web-host'

const NONE: SessionViewer[] = []

/**
 * In the top bar, the other devices that have the session in front right now, the first by name
 * and all of them in the tooltip; nothing while the session's host is not connected.
 */
export function ViewersChip({
  sessionId,
  projectPath,
}: {
  sessionId: string
  projectPath: string
}) {
  const { t } = useTranslation('session')
  const viewers = useViewersStore((s) => s.bySession[sessionId] ?? NONE)
  const hostId = hostOfPath(projectPath)
  const other = useOtherHost(hostId)
  const served = useWebHostStore((s) => s.host)
  const label = useHostLabel(hostId)
  const connected =
    hostId !== null
      ? other?.connection.state === 'online'
      : !isWeb || served?.connection.state === 'online'
  if (!connected || viewers.length === 0) return null
  const names = viewerNames(viewers, hostId === null && served ? served.name : label)
  const text =
    names.length === 1 ? names[0] : t('viewers.more', { name: names[0], count: names.length - 1 })
  const all = t('viewers.label', { names })
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={all}
            className="ml-1.5 inline-flex h-6 min-w-7 shrink items-center gap-[5px] overflow-hidden rounded-md bg-subtle px-2 text-xs text-tertiary"
          />
        }
      >
        <EyeIcon aria-hidden className="size-3 shrink-0" />
        <span className="max-w-32 truncate">{text}</span>
      </TooltipTrigger>
      <TooltipContent>{all}</TooltipContent>
    </Tooltip>
  )
}
