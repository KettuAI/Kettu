// Settings › Agents › SOP: whether agents may suggest an SOP, and which Claude Code and Codex
// agents Auto may pick for a step. Both are the host's, kept beside its SOP library.

import { useTranslation } from 'react-i18next'
import { useHostScope } from '@renderer/stores/host-scope'
import { useHostSops } from '@renderer/stores/sops'
import { english, type GroupDef, type RowDef } from './model'
import { EmptyRow, GroupNote } from './rows'
import { changedAgents } from './sop-data'
import { AgentsLoading, AutoPickRow, ReadFailed, ResetAuto, SuggestSwitch } from './sop-rows'

/** The SOP group and the agents Auto can pick, for the end of Settings › Agents. */
export function useSopRows(): RowDef[] {
  const { t } = useTranslation('settings')
  const en = english()
  const { hostId, useAgentsStore } = useHostScope()
  const { settings, loaded, error } = useHostSops(hostId)
  const byId = useAgentsStore((s) => s.byId)
  const sopGroup: GroupDef = { id: 'sop', label: t('agents.sop.group') }
  const autoGroup: GroupDef = {
    id: 'sop-auto',
    label: t('agents.sop.auto.group'),
    actions: changedAgents(settings).length > 0 ? <ResetAuto /> : undefined,
    note: (
      <>
        <GroupNote>{t('agents.sop.auto.note')}</GroupNote>
        <GroupNote>{t('agents.sop.auto.apiKeys')}</GroupNote>
      </>
    ),
  }
  const keywords = t('agents.sop.keywords')
  const rows: RowDef[] = [
    {
      id: 'sop-suggest',
      name: t('agents.sop.suggest.name'),
      english: en('agents.sop.suggest.name'),
      description: t('agents.sop.suggest.description'),
      keywords,
      group: sopGroup,
      render: () => <SuggestSwitch />,
    },
  ]
  if (!settings) {
    rows.push({
      id: 'sop-auto-state',
      name: t('agents.sop.auto.group'),
      english: en('agents.sop.auto.group'),
      keywords,
      group: autoGroup,
      layout: 'custom',
      render: () => (loaded && error ? <ReadFailed error={error} /> : <AgentsLoading />),
    })
    return rows
  }
  if (settings.agents.length === 0) {
    rows.push({
      id: 'sop-auto-none',
      name: t('agents.sop.auto.group'),
      english: en('agents.sop.auto.group'),
      keywords,
      group: autoGroup,
      layout: 'custom',
      render: () => (
        <EmptyRow title={t('agents.sop.auto.noneTitle')} hint={t('agents.sop.auto.noneHint')} />
      ),
    })
    return rows
  }
  for (const agent of settings.agents) {
    const status = byId[agent.agentId]
    const name = status?.name ?? agent.agentId
    rows.push({
      id: `sop-auto:${agent.agentId}`,
      name: t('agents.sop.auto.rowName', { agent: name }),
      english: en('agents.sop.auto.rowName', { agent: name }),
      description: status?.account?.label ?? undefined,
      keywords: `${keywords} ${name}`,
      group: autoGroup,
      layout: 'custom',
      render: () => (
        <AutoPickRow
          agentId={agent.agentId}
          name={name}
          account={status?.account?.kind === 'none' ? null : (status?.account ?? null)}
          allowed={agent.allowed}
          byDefault={agent.byDefault}
        />
      ),
    })
  }
  return rows
}
