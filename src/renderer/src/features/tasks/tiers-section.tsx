import type { ReactNode } from 'react'
import { WorkflowSquare03Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { TASK_TIERS } from '@shared/tasks'
import { english, type RowDef, type SectionDef } from '@renderer/features/settings/model'
import { GroupNote } from '@renderer/features/settings/rows'
import { i18n } from '@renderer/lib/i18n'
import { TierList } from './tier-list'

/** Settings › Tasks: each tier's agents and models, in the order a stage tries them. */
export function useTasksSection(): SectionDef {
  const { t } = useTranslation('settings')
  const { t: tt } = useTranslation('tasks')
  const en = english()
  const enTasks = i18n.getFixedT('en', 'tasks')
  const group = {
    id: 'tiers',
    label: t('sections.tasks'),
    unlabeled: true,
    note: <GroupNote>{tt('settings.intro')}</GroupNote>,
  }
  const rows: RowDef[] = TASK_TIERS.map((tier) => ({
    id: `tier-${tier}`,
    name: tt(`settings.tier.${tier}`),
    english: `${enTasks(`settings.tier.${tier}`)} ${en('sections.tasks')}`,
    description: tt(`settings.tierNote.${tier}`),
    group,
    layout: 'block',
    render: (text: ReactNode) => <TierList tier={tier} text={text} />,
  }))
  return {
    id: 'tasks',
    title: t('sections.tasks'),
    description: t('pages.tasks'),
    icon: WorkflowSquare03Icon,
    rows,
  }
}
