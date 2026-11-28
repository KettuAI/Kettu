// Settings > Agents > Bots: manage/create Bots, host-wide concurrency cap, and agent handoff switch.

import { useTranslation } from 'react-i18next'
import type { GroupDef, RowDef } from './model'
import { BotAllowHandoffSwitch, BotManageRow, BotMaxConcurrentField } from './bot-settings-rows'
import { GroupNote } from './rows'

/** Bots settings group under Settings > Agents. */
export function useBotSettingsRows(): RowDef[] {
  const { t } = useTranslation(['settings', 'bots'])
  const group: GroupDef = {
    id: 'bots',
    label: t('settings:agents.bots.group'),
    note: <GroupNote>{t('settings:agents.bots.note')}</GroupNote>,
  }
  return [
    {
      id: 'bots-manage',
      setting: 'agents.bots-manage',
      group,
      render: () => <BotManageRow />,
    },
    {
      id: 'bots-max-concurrent',
      setting: 'agents.bots-max-concurrent',
      group,
      render: () => <BotMaxConcurrentField label={t('settings:agents.bots.maxConcurrent.name')} />,
    },
    {
      id: 'bots-allow-handoff',
      setting: 'agents.bots-allow-handoff',
      group,
      render: () => <BotAllowHandoffSwitch label={t('settings:agents.bots.allowHandoff.name')} />,
    },
  ]
}
