import { useTranslation } from 'react-i18next'
import { isMac, isWeb, platform } from '@renderer/lib/platform'
import { useOtherHost } from '@renderer/stores/hosts'
import { useWebHostStore } from '@renderer/stores/web-host'

/** A host's name and system as the tray shows them; this computer is the one serving a browser. */
export function useHostInfo(hostId: string | null): { name: string; platform: string } {
  const { t } = useTranslation('composer')
  const other = useOtherHost(hostId)
  const web = useWebHostStore((s) => s.host)
  if (hostId !== null) {
    return { name: other?.name ?? t('place.unknownHost'), platform: other?.platform ?? '' }
  }
  if (isWeb) return { name: web?.name ?? '', platform: web?.platform ?? '' }
  return { name: t('place.thisComputer', isMac ? { context: 'mac' } : {}), platform }
}
