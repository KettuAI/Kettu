import { useTranslation } from 'react-i18next'
import { useOtherHost } from '@renderer/stores/hosts'

/** A host's name, this computer's as "This computer". */
export function useHostLabel(hostId: string | null): string {
  const { t } = useTranslation('sidebar')
  const host = useOtherHost(hostId)
  return hostId === null ? t('hosts.thisComputer') : (host?.name ?? t('hosts.unknown'))
}
