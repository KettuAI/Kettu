import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { HostIcon } from '@renderer/features/settings/remote-parts'
import { connectionText } from '@renderer/features/settings/host-text'
import { hostOfPath } from '@renderer/lib/host-paths'
import { useNow } from '@renderer/lib/use-now'
import { useOtherHost } from '@renderer/stores/hosts'
import { openSettingsItem } from '@renderer/stores/view'

/**
 * Before a top bar's title, the other host its project is on, which opens the host's page in
 * Settings > Hosts; nothing for this computer's.
 */
export function HostChip({ projectPath }: { projectPath: string | null }) {
  const { t } = useTranslation('settings')
  const now = useNow()
  const hostId = projectPath === null ? null : hostOfPath(projectPath)
  const host = useOtherHost(hostId)
  if (!hostId || !host) return null
  const state = connectionText(t, host, now)
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          aria-label={t('hosts.chip.label', { name: host.name, state })}
          onClick={() => openSettingsItem('hosts', hostId)}
          className="inline-flex h-6 shrink-0 items-center gap-[5px] rounded-sm bg-hover pr-[7px] pl-1.5 text-xs text-primary outline-none hover:bg-selected focus-visible:ring-2 focus-visible:ring-ring"
        >
          <HostIcon platform={host.platform} className="size-3 shrink-0" />
          <span className="max-w-32 truncate">{host.name}</span>
        </TooltipTrigger>
        <TooltipContent>{t('hosts.chip.tooltip', { name: host.name, state })}</TooltipContent>
      </Tooltip>
      <span aria-hidden className="mx-0.5 shrink-0 text-border-strong">
        /
      </span>
    </>
  )
}
