import { useEffect, type ReactNode } from 'react'
import { WorkflowSquare03Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { TASK_TIERS } from '@shared/tasks'
import { english, type RowDef, type SectionDef } from '@renderer/features/settings/model'
import { GroupNote } from '@renderer/features/settings/rows'
import { i18n } from '@renderer/lib/i18n'
import { useHostScope } from '@renderer/stores/host-scope'
import { hostKey, useTasksStore } from '@renderer/stores/tasks'
import { sopKey } from './model'
import { SopListState, SopRow } from './sop-row'
import { TierChoiceRow } from './tier-choice'

/** Settings › SOPs: the host's SOPs, and the agent and model each tier stands for. */
export function useSopsSection(): SectionDef {
  const { t } = useTranslation('settings')
  const { t: tt } = useTranslation('tasks')
  const { hostId } = useHostScope()
  const list = useTasksStore((s) => s.sops[hostKey(hostId)]?.value)
  const en = english()
  const enTasks = i18n.getFixedT('en', 'tasks')

  useEffect(() => {
    void useTasksStore.getState().loadSops(hostId)
  }, [hostId])

  const sops = { id: 'sops', label: tt('settings.sops.group') }
  const sopRows: RowDef[] =
    list && list.length > 0
      ? list.map((sop) => ({
          id: `sop-${sopKey(sop)}`,
          name: sop.name,
          description: sop.description,
          english: en('sections.sops'),
          group: sops,
          layout: 'custom',
          render: () => <SopRow sop={sop} hostId={hostId} />,
        }))
      : [
          {
            id: 'sops',
            name: tt('settings.sops.group'),
            english: en('sections.sops'),
            description: tt('settings.sops.description'),
            group: sops,
            layout: 'custom',
            render: () => <SopListState hostId={hostId} />,
          },
        ]

  const tiers = {
    id: 'tiers',
    label: tt('settings.tiers'),
    note: <GroupNote>{tt('settings.intro')}</GroupNote>,
  }
  const tierRows: RowDef[] = TASK_TIERS.map((tier) => ({
    id: `tier-${tier}`,
    name: tt(`settings.tier.${tier}`),
    english: `${enTasks(`settings.tier.${tier}`)} ${en('sections.sops')}`,
    description: tt(`settings.tierNote.${tier}`),
    group: tiers,
    layout: 'block',
    render: (text: ReactNode) => <TierChoiceRow tier={tier} text={text} />,
  }))
  return {
    id: 'sops',
    title: t('sections.sops'),
    description: t('pages.sops'),
    icon: WorkflowSquare03Icon,
    rows: [...sopRows, ...tierRows],
  }
}
