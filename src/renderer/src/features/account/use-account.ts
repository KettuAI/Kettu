import { useTranslation } from 'react-i18next'
import { useNotices } from '@renderer/features/sidebar/notices'
import { useUpdates } from '@renderer/features/updates/use-updates'
import { useHostsStore } from '@renderer/stores/hosts'
import { useRemoteStore } from '@renderer/stores/remote'
import { useUpdatesStore } from '@renderer/stores/updates'

/** This computer's name, as devices see it: "Studio Mac". */
export function useThisComputerName(): string {
  const { t } = useTranslation('sidebar')
  const remote = useRemoteStore((s) => s.status?.hostName)
  const self = useHostsStore((s) => s.status?.self.name)
  return remote || self || t('hosts.thisComputer')
}

/**
 * Whether Settings needs you: an agent to sign in, or updates the card was closed on that are still
 * to do, until Settings is opened.
 */
export function useSettingsAttention(): boolean {
  const { signIn } = useNotices()
  const dot = useUpdatesStore((s) => s.settingsDot)
  const status = useUpdatesStore((s) => s.status)
  const { items } = useUpdates()
  if (signIn.length > 0) return true
  if (!dot) return false
  const state = status?.state
  const appDismissed =
    (state?.kind === 'ready' || state?.kind === 'available') && status?.dismissed === state.version
  return appDismissed || items.some((item) => item.kind === 'harness' && item.skipped)
}
