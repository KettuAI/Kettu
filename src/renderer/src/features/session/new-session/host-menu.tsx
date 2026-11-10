import { useTranslation } from 'react-i18next'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { HostChip } from '@renderer/features/session/composer/host-chip'
import { useHostInfo } from '@renderer/features/session/composer/host-info'
import { HostIcon } from '@renderer/features/settings/remote-parts'
import { isAway, useOtherHosts } from '@renderer/stores/hosts'
import { THIS_COMPUTER } from '@renderer/stores/view'

/**
 * New session's host, the first of the tray's choices: this computer and the other hosts, whose
 * projects and agents follow it. With no other host there is nothing to choose, so it is shown
 * as the session's tray shows it.
 */
export function HostMenu({
  hostId,
  onChoose,
}: {
  hostId: string | null
  onChoose: (hostId: string | null) => void
}) {
  const { t } = useTranslation('session')
  const hosts = useOtherHosts()
  const here = useHostInfo(null)
  const chosen = useHostInfo(hostId)
  if (hosts.length === 0) return <HostChip hostId={hostId} />

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={t('newSession.host')}
            className="ui-as-tray-link kettu-tray-link--host"
          />
        }
      >
        <HostIcon platform={chosen.platform} className="size-3.5" />
        <span className="kettu-tray-link__text">{chosen.name}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="min-w-56">
        <DropdownMenuRadioGroup
          value={hostId ?? THIS_COMPUTER}
          onValueChange={(value) => onChoose(value === THIS_COMPUTER ? null : String(value))}
        >
          <DropdownMenuRadioItem value={THIS_COMPUTER}>
            <HostIcon platform={here.platform} />
            <span className="min-w-0 flex-1 truncate">{here.name}</span>
          </DropdownMenuRadioItem>
          {hosts.map((host) => (
            <DropdownMenuRadioItem key={host.id} value={host.id} disabled={isAway(host.connection)}>
              <HostIcon platform={host.platform} />
              <span className="min-w-0 flex-1 truncate">{host.name}</span>
              {isAway(host.connection) && (
                <span className="shrink-0 pr-1 text-xs text-muted-foreground">
                  {t('newSession.hostOffline')}
                </span>
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
