// Settings › Agents › workflow: whether agents may suggest a workflow, and which Claude Code and Codex
// agents Auto may pick for a step. Both are the host's, kept beside its workflow library.

import { useTranslation } from 'react-i18next'
import { useHostScope } from '@renderer/stores/host-scope'
import { useHostWorkflows } from '@renderer/stores/workflows'
import { english, type GroupDef, type RowDef } from './model'
import { EmptyRow, GroupNote } from './rows'
import { changedAgents } from './workflow-data'
import { AgentsLoading, AutoPickRow, ReadFailed, ResetAuto, SuggestSwitch } from './workflow-rows'

/** The workflow group and the agents Auto can pick, for the end of Settings › Agents. */
export function useWorkflowRows(): RowDef[] {
  const { t } = useTranslation('settings')
  const en = english()
  const { hostId, useAgentsStore } = useHostScope()
  const { settings, loaded, error } = useHostWorkflows(hostId)
  const byId = useAgentsStore((s) => s.byId)
  const workflowGroup: GroupDef = { id: 'workflow', label: t('agents.workflow.group') }
  const autoGroup: GroupDef = {
    id: 'workflow-auto',
    label: t('agents.workflow.auto.group'),
    actions: changedAgents(settings).length > 0 ? <ResetAuto /> : undefined,
    note: (
      <>
        <GroupNote>{t('agents.workflow.auto.note')}</GroupNote>
        <GroupNote>{t('agents.workflow.auto.apiKeys')}</GroupNote>
      </>
    ),
  }
  const keywords = t('agents.workflow.keywords')
  const rows: RowDef[] = [
    {
      id: 'workflow-suggest',
      name: t('agents.workflow.suggest.name'),
      english: en('agents.workflow.suggest.name'),
      description: t('agents.workflow.suggest.description'),
      keywords,
      group: workflowGroup,
      render: () => <SuggestSwitch />,
    },
  ]
  if (!settings) {
    rows.push({
      id: 'workflow-auto-state',
      name: t('agents.workflow.auto.group'),
      english: en('agents.workflow.auto.group'),
      keywords,
      group: autoGroup,
      layout: 'custom',
      render: () => (loaded && error ? <ReadFailed error={error} /> : <AgentsLoading />),
    })
    return rows
  }
  if (settings.agents.length === 0) {
    rows.push({
      id: 'workflow-auto-none',
      name: t('agents.workflow.auto.group'),
      english: en('agents.workflow.auto.group'),
      keywords,
      group: autoGroup,
      layout: 'custom',
      render: () => (
        <EmptyRow
          title={t('agents.workflow.auto.noneTitle')}
          hint={t('agents.workflow.auto.noneHint')}
        />
      ),
    })
    return rows
  }
  for (const agent of settings.agents) {
    const status = byId[agent.agentId]
    const name = status?.name ?? agent.agentId
    rows.push({
      id: `workflow-auto:${agent.agentId}`,
      name: t('agents.workflow.auto.rowName', { agent: name }),
      english: en('agents.workflow.auto.rowName', { agent: name }),
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
