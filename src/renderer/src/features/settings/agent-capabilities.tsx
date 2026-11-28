// Unified harness integration completeness checklist shown inside Settings > Agents.

import { ArrowDown01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { AgentStatus } from '@shared/agent-host'
import {
  resolveHarnessCapabilities,
  summarizeHarnessCapabilities,
  type CapabilityGapReason,
  type CapabilityNoteKey,
  type CapabilitySupport,
  type HarnessCapabilityId,
  type ResolvedHarnessCapability,
} from '@shared/harness-capabilities'
import { Icon } from '@renderer/components/affect/app-shell'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import { PANEL } from '@renderer/features/session/entries/helpers'
import { RowGroup, RowShell, RowText } from './rows'

const STATUS_KEYS: Readonly<Record<CapabilitySupport, string>> = {
  supported: 'agents.capabilities.status.supported',
  partial: 'agents.capabilities.status.partial',
  unavailable: 'agents.capabilities.status.unavailable',
}

const REASON_KEYS: Readonly<Record<CapabilityGapReason, string>> = {
  upstream: 'agents.capabilities.reason.upstream',
  kettu: 'agents.capabilities.reason.kettu',
}

const ITEM_KEYS: Readonly<Record<HarnessCapabilityId, string>> = {
  steering: 'agents.capabilities.items.steering',
  rewind: 'agents.capabilities.items.rewind',
  fileRewind: 'agents.capabilities.items.fileRewind',
  fork: 'agents.capabilities.items.fork',
  imageInput: 'agents.capabilities.items.imageInput',
  mcp: 'agents.capabilities.items.mcp',
  contextBreakdown: 'agents.capabilities.items.contextBreakdown',
  usageHistory: 'agents.capabilities.items.usageHistory',
  planLimits: 'agents.capabilities.items.planLimits',
  sideChat: 'agents.capabilities.items.sideChat',
  workflowsAndRoutines: 'agents.capabilities.items.workflowsAndRoutines',
}

const NOTE_KEYS: Readonly<Record<CapabilityNoteKey, string>> = {
  acpNoForkAtMessage: 'agents.capabilities.notes.acpNoForkAtMessage',
  acpNoRewind: 'agents.capabilities.notes.acpNoRewind',
  acpStdioAlwaysHttpDepends: 'agents.capabilities.notes.acpStdioAlwaysHttpDepends',
  acpStdioOnlyNoHttp: 'agents.capabilities.notes.acpStdioOnlyNoHttp',
  agyNoSilentDelete: 'agents.capabilities.notes.agyNoSilentDelete',
  clineModelRequestsOnly: 'agents.capabilities.notes.clineModelRequestsOnly',
  clineSdkOnly: 'agents.capabilities.notes.clineSdkOnly',
  codexEstimatesOnly: 'agents.capabilities.notes.codexEstimatesOnly',
  codexPaginatedThreadsOnly: 'agents.capabilities.notes.codexPaginatedThreadsOnly',
  deepseekBalanceOnly: 'agents.capabilities.notes.deepseekBalanceOnly',
  dependsOnAcpAdapter: 'agents.capabilities.notes.dependsOnAcpAdapter',
  limitsAdministratorManaged: 'agents.capabilities.notes.limitsAdministratorManaged',
  limitsHarnessDoesNotOffer: 'agents.capabilities.notes.limitsHarnessDoesNotOffer',
  limitsModelProviderManaged: 'agents.capabilities.notes.limitsModelProviderManaged',
  limitsNotYetSupported: 'agents.capabilities.notes.limitsNotYetSupported',
  limitsVendorDisallows: 'agents.capabilities.notes.limitsVendorDisallows',
  noSilentSessionDelete: 'agents.capabilities.notes.noSilentSessionDelete',
  piExtensionRequired: 'agents.capabilities.notes.piExtensionRequired',
  piNoPermissionPrompts: 'agents.capabilities.notes.piNoPermissionPrompts',
  routinesOnlyNoWorkflows: 'agents.capabilities.notes.routinesOnlyNoWorkflows',
  sideChatHiddenCopyOnly: 'agents.capabilities.notes.sideChatHiddenCopyOnly',
}

function CapabilityRow({ item }: { item: ResolvedHarnessCapability }) {
  const { t } = useTranslation('settings')
  const title = t(ITEM_KEYS[item.id] as 'agents.capabilities.items.steering')
  const detail = item.note
    ? t(NOTE_KEYS[item.note] as 'agents.capabilities.notes.acpNoRewind')
    : undefined
  const reason =
    item.status !== 'supported' && item.gapReason
      ? t(REASON_KEYS[item.gapReason] as 'agents.capabilities.reason.upstream')
      : null
  const statusLabel = t(STATUS_KEYS[item.status] as 'agents.capabilities.status.supported')

  return (
    <RowShell>
      <div className="ui-sg-row k-cap-row" data-capability={item.id} data-status={item.status}>
        <RowText name={title} description={detail} />
        <span className="k-cap-meta">
          {reason && (
            <span className="k-cap-reason" data-reason={item.gapReason}>
              {reason}
            </span>
          )}
          <span className="k-cap-status" data-status={item.status}>
            {statusLabel}
          </span>
        </span>
      </div>
    </RowShell>
  )
}

/**
 * Collapsible checklist of Kettu integration completeness for an agent's underlying harness.
 * Always keeps the summary counts visible in its header without crowding primary controls.
 */
export function AgentCapabilitiesGroup({
  status,
  defaultOpen = true,
}: {
  status: Pick<AgentStatus, 'id' | 'capabilities'>
  defaultOpen?: boolean
}) {
  const { t } = useTranslation('settings')
  const items = resolveHarnessCapabilities(status.id, status.capabilities)
  const summary = summarizeHarnessCapabilities(items)
  const title = t('agents.capabilities.title')
  const summaryText = t('agents.capabilities.summary', {
    supported: summary.supported,
    partial: summary.partial,
    unavailable: summary.unavailable,
  })

  return (
    <section className="k-group" aria-label={title}>
      <Collapsible defaultOpen={defaultOpen}>
        <CollapsibleTrigger className="ui-sg-head k-disclosure k-cap-head">
          <Icon icon={ArrowDown01Icon} size={14} />
          <span className="k-cap-head__title">{title}</span>
          <span className="k-cap-head__summary" data-cap-summary="">
            {summaryText}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className={PANEL}>
          <div className="k-disclosure__body">
            <RowGroup label={title}>
              {items.map((item) => (
                <CapabilityRow key={item.id} item={item} />
              ))}
            </RowGroup>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  )
}
