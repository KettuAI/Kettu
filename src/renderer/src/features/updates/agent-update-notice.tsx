import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { errorMessage, host } from '@renderer/lib/host'
import { usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { openAgentSettings, openSettings, useViewStore } from '@renderer/stores/view'
import { agentUpdateNotice } from './agent-updates'
import { NoticeCard } from './update-notice'

/** A newer Claude Code or Codex, or adapter, in the sidebar footer, above the app's notice. */
export function AgentUpdateNotice() {
  const { t } = useTranslation('updates')
  const statuses = useAgentsStore(useShallow((s) => usableAgents(s.order, s.byId)))
  const agentsSettingsOpen = useViewStore((s) => s.settings.open && s.settings.section === 'agents')
  const notice = agentUpdateNotice(statuses)
  if (!notice || agentsSettingsOpen) return null

  const open = () => {
    if (notice.kind === 'one') openAgentSettings(notice.agentId)
    else openSettings('agents')
  }

  const dismiss = () => {
    const agentIds = notice.kind === 'one' ? [notice.agentId] : notice.agentIds
    for (const agentId of agentIds) {
      void host('agents.skipUpdate', { agentId }).catch((error: unknown) =>
        console.warn(`Could not skip the agent update: ${errorMessage(error)}`),
      )
    }
  }

  const tooltip =
    notice.kind === 'one'
      ? t('agentNotice.oneTooltip', { name: notice.name, version: notice.version })
      : t('agentNotice.manyTooltip', { count: notice.agentIds.length })

  // The words hide whole once the label cannot hold them beside the value.
  return (
    <NoticeCard tooltip={tooltip} onClick={open} onDismiss={dismiss}>
      {notice.kind === 'one' ? (
        <>
          <AgentMark agent={notice.agentId} size={14} />
          <span className="@container/notice flex min-w-0 flex-1 items-baseline gap-1.5 whitespace-nowrap">
            <span className="truncate font-medium @max-[10rem]/notice:sr-only">
              {t('agentNotice.one', { name: notice.name })}
            </span>
            <span className="shrink-0 font-mono text-meta text-tertiary tabular">
              {notice.version}
            </span>
          </span>
        </>
      ) : (
        <span className="@container/notice flex min-w-0 flex-1 items-baseline gap-1.5 whitespace-nowrap">
          <span className="truncate font-medium @max-[7rem]/notice:sr-only">
            {t('agentNotice.many')}
          </span>
          <span className="shrink-0 font-mono text-meta text-tertiary tabular">
            {notice.agentIds.length}
          </span>
        </span>
      )}
    </NoticeCard>
  )
}
