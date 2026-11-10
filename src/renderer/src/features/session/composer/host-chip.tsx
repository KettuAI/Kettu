import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { HostIcon } from '@renderer/features/settings/remote-parts'
import { useHostInfo } from './host-info'

/** The host on the tray, shown and not chosen. */
export function HostChip({ hostId }: { hostId: string | null }) {
  const host = useHostInfo(hostId)
  if (!host.name) return null
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="ui-as-tray-link kettu-tray-link--host" data-static="" />}
      >
        <HostIcon platform={host.platform} className="size-3.5" />
        <span className="kettu-tray-link__text">{host.name}</span>
      </TooltipTrigger>
      <TooltipContent>{host.name}</TooltipContent>
    </Tooltip>
  )
}
