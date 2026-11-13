import { useMemo, useState } from 'react'
import { Combobox as ComboboxPrimitive } from '@base-ui/react/combobox'
import { Search01Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentId } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { AgentMarkHost } from '@renderer/components/agents/agent-mark-host'
import { Button } from '@renderer/components/ui/button'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxSeparator,
  useComboboxFilter,
} from '@renderer/components/ui/combobox'
import { InputGroupAddon } from '@renderer/components/ui/input-group'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { SettingsGlyph } from '@renderer/features/account/avatar'
import { useHostLabel } from '@renderer/features/sidebar/host-label'
import { errorMessage } from '@renderer/lib/host'
import { newestLimits } from '@renderer/lib/plan-readings'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { Glyph } from '@renderer/features/shell/glyph'
import {
  agentName,
  agentsOn,
  usableAgents,
  useAgentsStore,
  usePlanReadings,
} from '@renderer/stores/agents'
import { refreshLimits } from '@renderer/stores/usage'
import { openAgentSettings } from '@renderer/stores/view'
import { menuAgents } from './start-options'
import { agentLine, type LineTone } from './picker'
import { refreshOnMenu } from './prepared'

const LINE_TONE: Record<LineTone, string> = {
  muted: 'text-tertiary',
  attention: 'text-attention',
  danger: 'text-danger',
}

/**
 * New session's agent: a chip naming the chosen agent, and a menu of the agents it can start,
 * each with its account and plan use or what it needs, under one search.
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
  const readings = usePlanReadings()
  const statuses = useAgentsStore(
    useShallow((s) => {
      const { order, byId } = agentsOn(s, hostId)
      return menuAgents(usableAgents(order, byId))
    }),
  )
  // This computer's agents are read after launch: until then the list is loading, not empty.
  const agentsRead = useAgentsStore((s) => hostId !== null || s.loaded)
  const ids = useMemo(() => statuses.map((s) => s.id), [statuses])
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
    refreshOnMenu(
      hostId,
      statuses.filter((s) => s.state === 'ready').map((s) => s.id),
    )
  }

  return (
    // Marks inside show this host's agents, the second-account dots included.
    <AgentMarkHost.Provider value={hostId}>
      <Combobox
        items={ids}
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
        <ComboboxPrimitive.Trigger
          render={
            <button
              type="button"
              aria-label={t('newSession.agent')}
              className="ui-as-tray-link kettu-tray-link--agent"
            />
          }
        >
          {agentId ? (
            <>
              <AgentMark agent={agentId} size={13} className="shrink-0" />
              <span className="kettu-tray-link__text" title={agentName(agentId, hostId)}>
                {agentName(agentId, hostId)}
              </span>
            </>
          ) : (
            <span className="kettu-tray-link__text">{t('newSession.chooseAgentShort')}</span>
          )}
        </ComboboxPrimitive.Trigger>
        <ComboboxContent
          align="start"
          sideOffset={8}
          className="kettu-agent-menu flex w-70 flex-col"
        >
          <ComboboxInput
            showTrigger={false}
            placeholder={t('newSession.picker.search')}
            aria-label={t('newSession.picker.search')}
            spellCheck={false}
            className="h-10.5! px-2"
          >
            <InputGroupAddon>
              <Glyph icon={Search01Icon} size={14} />
            </InputGroupAddon>
          </ComboboxInput>
          {!agentsRead ? (
            <div className="flex flex-col gap-1 px-1.5 pt-0.5 pb-1.5" aria-hidden>
              {[0, 1].map((i) => (
                <Skeleton key={i} className="h-11 w-full rounded-xl" />
              ))}
            </div>
          ) : statuses.length === 0 ? (
            <p className="px-3.5 py-3 text-ui text-muted-foreground">
              {hostId === null
                ? t('newSession.noAgent')
                : t('newSession.noAgentOnHost', { host: hostLabel })}
            </p>
          ) : (
            <ComboboxList className="max-h-[min(--spacing(110),calc(var(--available-height)---spacing(24)))] scroll-fade-y px-1.5 pt-0.5 pb-1.5">
              {(id: AgentId) => {
                const status = byId.get(id)
                if (!status) return null
                const line = agentLine(status, now, newestLimits(readings, status))
                return (
                  <ComboboxItem
                    key={id}
                    value={id}
                    className="group/agent h-11 gap-2.5 rounded-xl py-1 pr-2 pl-2 data-highlighted:bg-hover [&>span.absolute]:hidden"
                  >
                    <AgentMark agent={id} size={16} className="shrink-0" />
                    <span className="flex min-w-0 flex-1 flex-col gap-px">
                      <span className="truncate text-menu text-primary">{status.name}</span>
                      {line && (
                        <span className={cn('truncate text-small', LINE_TONE[line.tone])}>
                          {line.text}
                        </span>
                      )}
                    </span>
                    {id === agentId && (
                      <Glyph icon={Tick02Icon} size={15} className="shrink-0 text-primary" />
                    )}
                  </ComboboxItem>
                )
              }}
            </ComboboxList>
          )}
          {agentsRead && <ComboboxEmpty>{t('newSession.picker.noMatch')}</ComboboxEmpty>}
          {/* Settings set up this computer's agents, not another host's. */}
          {hostId === null && (
            <>
              <ComboboxSeparator className="mx-0 my-0" />
              <div className="p-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8.5 w-full justify-start gap-2.5 rounded-xl px-2 text-control font-normal text-secondary [&>svg]:size-4"
                  onClick={() => {
                    setOpen(false)
                    openAgentSettings(null)
                  }}
                >
                  <SettingsGlyph />
                  {t('newSession.picker.manage')}
                </Button>
              </div>
            </>
          )}
        </ComboboxContent>
      </Combobox>
    </AgentMarkHost.Provider>
  )
}
