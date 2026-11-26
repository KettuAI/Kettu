// 设置 › 智能体 › Bots：整机 Bot 并发上限与是否允许普通会话 Agent 委派给 Bot。

import { useTranslation } from 'react-i18next'
import type { GroupDef, RowDef } from './model'
import { BotAllowHandoffSwitch, BotMaxConcurrentField } from './bot-settings-rows'
import { GroupNote } from './rows'

/** 设置 › 智能体 底部 Bots 全局设置分组。 */
export function useBotSettingsRows(): RowDef[] {
  const { t } = useTranslation('settings')
  const group: GroupDef = {
    id: 'bots',
    label: t('agents.bots.group'),
    note: <GroupNote>{t('agents.bots.note')}</GroupNote>,
  }
  return [
    {
      id: 'bots-max-concurrent',
      setting: 'agents.bots-max-concurrent',
      group,
      render: () => <BotMaxConcurrentField label={t('agents.bots.maxConcurrent.name')} />,
    },
    {
      id: 'bots-allow-handoff',
      setting: 'agents.bots-allow-handoff',
      group,
      render: () => <BotAllowHandoffSwitch label={t('agents.bots.allowHandoff.name')} />,
    },
  ]
}
