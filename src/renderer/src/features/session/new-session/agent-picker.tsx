import { useMemo, useState } from 'react'
import { CheckIcon, SearchIcon, SlidersHorizontalIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentId } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
  useComboboxFilter,
} from '@renderer/components/ui/combobox'
import { InputGroupAddon } from '@renderer/components/ui/input-group'
import { useHostLabel } from '@renderer/features/sidebar/host-label'
import { errorMessage } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { agentName, agentsOn, usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { refreshLimits } from '@renderer/stores/usage'
import { openAgentSettings } from '@renderer/stores/view'
import { menuAgents } from './start-options'
import { agentGroups, agentLine, type AgentGroup, type LineTone } from './picker'
import { refreshOnMenu } from './prepared'

const LINE_TONE: Record<LineTone, string> = {
  muted: 'text-tertiary',
  attention: 'text-attention',
  danger: 'text-danger',
}

/**
 * New session's agent: a chip naming the chosen agent, and a menu of the agents it can start,
 * grouped by harness, each with its account and plan use or what it needs, under one search.
 * Choosing one keeps the model the agent starts with; the model has a menu of its own.
 */
export function AgentPicker({
  agentId,
  onChoose,
  hostId = null,
}: {
  agentId: AgentId | null
  onChoose: (agentId: AgentId) => void
  /** The other host New session's project is on, whose agents the menu lists; null for this computer. */
  hostId?: string | null
}) {
  const { t } = useTranslation('session')
  const hostLabel = useHostLabel(hostId)
  const now = useNow()
  const statuses = useAgentsStore(
    useShallow((s) => {
      const { order, byId } = agentsOn(s, hostId)
      return menuAgents(usableAgents(order, byId))
    }),
  )
  const groups = useMemo(() => agentGroups(statuses), [statuses])
  const byId = useMemo(() => new Map(statuses.map((s) => [s.id, s])), [statuses])
  const { contains } = useComboboxFilter()
  const [open, setOpen] = useState(false)

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) return
    for (const status of statuses) {
      if (status.state !== 'ready' || !status.capabilities.reports) continue
      refreshLimits(status.id, hostId).catch((error: unknown) =>
        console.warn(`Could not read the plan limits: ${errorMessage(error)}`),
      )
    }
    refreshOnMenu(statuses.filter((s) => s.state === 'ready').map((s) => s.id))
  }

  return (
    <Combobox
      items={groups.map((g) => ({ ...g, items: g.agents.map((a) => a.id) }))}
      value={agentId}
      open={open}
      onOpenChange={onOpenChange}
      onValueChange={(id: AgentId | null) => {
        if (id) onChoose(id)
      }}
      itemToStringLabel={(id: AgentId) => agentName(id, hostId)}
      filter={(id: AgentId, query: string) => {
        const status = byId.get(id)
        return !!status && contains(`${status.name} ${status.harnessName}`, query)
      }}
      autoHighlight
    >
      <ComboboxTrigger
        render={
          <Button
            variant="quiet"
            size="sm"
            aria-label={t('newSession.agent')}
            className="h-7.5 min-w-0 shrink gap-1.5 overflow-hidden rounded-xl bg-subtle px-2.25 text-control font-normal text-primary hover:bg-selected aria-expanded:bg-selected [&>[data-icon=inline-end]]:text-tertiary"
          />
        }
      >
        {agentId ? (
          <>
            <AgentMark agent={agentId} size={15} className="shrink-0" />
            <span className="min-w-0 truncate" title={agentName(agentId, hostId)}>
              {agentName(agentId, hostId)}
            </span>
          </>
        ) : (
          <span className="truncate">{t('newSession.chooseAgentShort')}</span>
        )}
      </ComboboxTrigger>
      {/* Below the composer's edge, its marks in line with the chip's. */}
      <ComboboxContent
        align="start"
        sideOffset={20}
        alignOffset={-14}
        className="flex w-85 flex-col"
      >
        <ComboboxInput
          showTrigger={false}
          placeholder={t('newSession.picker.search')}
          aria-label={t('newSession.picker.search')}
          spellCheck={false}
          // A menu's search keeps its bottom line when focused, not a field's focus ring.
          className="h-10.5! px-2 has-[[data-slot=input-group-control]:focus-visible]:shadow-[inset_0_calc(var(--hairline)*-1)_0_var(--border-soft)]!"
        >
          <InputGroupAddon>
            <SearchIcon className="size-3.5" />
          </InputGroupAddon>
        </ComboboxInput>
        {statuses.length === 0 ? (
          <p className="px-3.5 py-3 text-ui text-muted-foreground">
            {hostId === null
              ? t('newSession.noAgent')
              : t('newSession.noAgentOnHost', { host: hostLabel })}
          </p>
        ) : (
          <ComboboxList className="max-h-[min(--spacing(110),calc(var(--available-height)---spacing(24)))] scroll-fade-y px-1.5 pt-0.5 pb-1.5">
            {(group: AgentGroup & { items: AgentId[] }) => (
              <ComboboxGroup key={group.key} items={group.items}>
                <ComboboxLabel className="h-auto px-2 pt-2 pb-1 text-small font-medium text-tertiary">
                  {group.harness ??
                    (groups.length > 1
                      ? t('newSession.picker.other')
                      : t('newSession.picker.agents'))}
                </ComboboxLabel>
                <ComboboxCollection>
                  {(id: AgentId) => {
                    const status = byId.get(id)
                    if (!status) return null
                    const line = agentLine(status, now)
                    return (
                      <ComboboxItem
                        key={id}
                        value={id}
                        className="group/agent h-11 gap-2.5 rounded-xl py-1 pr-2 pl-2 data-highlighted:bg-hover [&>span.absolute]:hidden"
                      >
                        <AgentMark agent={id} size={20} className="shrink-0" />
                        <span className="flex min-w-0 flex-1 flex-col gap-px">
                          <span className="truncate text-lede leading-snug text-primary">
                            {status.name}
                          </span>
                          {line && (
                            <span className={cn('truncate text-small', LINE_TONE[line.tone])}>
                              {line.text}
                            </span>
                          )}
                        </span>
                        {id === agentId && (
                          <CheckIcon
                            aria-hidden
                            strokeWidth={1.75}
                            className="size-3.75 shrink-0 text-control-on"
                          />
                        )}
                      </ComboboxItem>
                    )
                  }}
                </ComboboxCollection>
              </ComboboxGroup>
            )}
          </ComboboxList>
        )}
        <ComboboxEmpty>{t('newSession.picker.noMatch')}</ComboboxEmpty>
        {/* Settings set up this computer's agents, not another host's. */}
        {hostId === null && (
          <>
            <ComboboxSeparator className="mx-0 my-0" />
            <div className="p-1.5">
              <Button
                variant="ghost"
                size="sm"
                className="h-8.5 w-full justify-start gap-2.5 rounded-xl px-2 text-control font-normal text-secondary"
                onClick={() => {
                  setOpen(false)
                  openAgentSettings(null)
                }}
              >
                <SlidersHorizontalIcon className="size-4" />
                {t('newSession.picker.manage')}
              </Button>
            </div>
          </>
        )}
      </ComboboxContent>
    </Combobox>
  )
}
