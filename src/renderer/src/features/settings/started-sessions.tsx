// Settings › Agents › Sessions agents start: how many sessions one session's agent may have
// working at once, start in a day, and be woken by reports. All are the host's.

import { useTranslation } from 'react-i18next'
import type { StartedLimitKey } from '@shared/started-sessions'
import type { SettingId } from '@shared/settings-catalog'
import type { GroupDef, RowDef } from './model'
import { GroupNote } from './rows'
import { LimitField } from './started-rows'

const ROWS: readonly { key: StartedLimitKey; setting: SettingId }[] = [
  { key: 'working', setting: 'agents.started-working' },
  { key: 'daily', setting: 'agents.started-daily' },
  { key: 'reports', setting: 'agents.started-reports' },
]

/** The group of limits, under Idle sessions. */
export function useStartedSessionRows(): RowDef[] {
  const { t } = useTranslation('settings')
  const group: GroupDef = {
    id: 'started-sessions',
    label: t('agents.started.group'),
    note: <GroupNote>{t('agents.started.note')}</GroupNote>,
  }
  return ROWS.map(({ key, setting }) => ({
    id: `started-${key}`,
    setting,
    group,
    render: () => <LimitField limit={key} label={t(`agents.started.${key}.name`)} />,
  }))
}
