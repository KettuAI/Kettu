import { useTranslation } from 'react-i18next'
import { useNotices } from '@renderer/features/sidebar/notices'
import { useUpdates } from '@renderer/features/updates/use-updates'
import { useHostsStore } from '@renderer/stores/hosts'
import { useRemoteStore } from '@renderer/stores/remote'
import { useUpdatesStore } from '@renderer/stores/updates'
import { settingsAttention } from './model'

/** This computer's name, as devices see it: "Studio Mac". */
export function useThisComputerName(): string {
  const { t } = useTranslation('sidebar')
  const remote = useRemoteStore((s) => s.status?.hostName)
  const self = useHostsStore((s) => s.status?.self.name)
  return remote || self || t('hosts.thisComputer')
}

/** Whether Settings needs you, which its button marks with a dot. */
export function useSettingsAttention(): boolean {
  const { signIn } = useNotices()
  const dot = useUpdatesStore((s) => s.settingsDot)
  const status = useUpdatesStore((s) => s.status)
  const { items } = useUpdates()
  return settingsAttention({ signIn: signIn.length, dot, status, items })
}
