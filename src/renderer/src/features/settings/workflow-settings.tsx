// Settings › Agents › workflow: whether agents may suggest a workflow, how many steps work at once,
// and which Claude Code and Codex agents Auto may pick for a step. All are the host's.

import { useTranslation } from 'react-i18next'
import { useHostScope } from '@renderer/stores/host-scope'
import { useHostWorkflows } from '@renderer/stores/workflows'
import type { GroupDef, RowDef } from './model'
import { EmptyRow, GroupNote } from './rows'
import { changedAgents } from './workflow-data'
import {
  AgentsLoading,
  AutoPickRow,
  ReadFailed,
  ResetAuto,
  StepLimitSelect,
  SuggestSwitch,
} from './workflow-rows'

/** The workflow group and the agents Auto can pick, for the end of Settings › Agents. */
export function useWorkflowRows(): RowDef[] {
  const { t } = useTranslation('settings')
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
  const rows: RowDef[] = [
    {
      id: 'workflow-suggest',
      setting: 'agents.workflow-suggest',
      group: workflowGroup,
      render: () => <SuggestSwitch />,
    },
    {
      id: 'workflow-steps',
      setting: 'agents.workflow-steps',
      group: workflowGroup,
      render: () => <StepLimitSelect label={t('agents.workflow.steps.name')} />,
    },
  ]
  if (!settings) {
    rows.push({
      id: 'workflow-auto-state',
      setting: 'agents.workflow-auto',
      group: autoGroup,
      layout: 'custom',
      render: () => (loaded && error ? <ReadFailed error={error} /> : <AgentsLoading />),
    })
    return rows
  }
  if (settings.agents.length === 0) {
    rows.push({
      id: 'workflow-auto-none',
      setting: 'agents.workflow-auto',
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
      setting: 'agents.workflow-auto',
      item: {
        name: t('agents.workflow.auto.rowName', { agent: name }),
        ...(status?.account?.label ? { description: status.account.label } : {}),
        keywords: name,
      },
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
