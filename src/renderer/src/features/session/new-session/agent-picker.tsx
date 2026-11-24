import { useEffect, useMemo, useState } from 'react'
import { Combobox as ComboboxPrimitive } from '@base-ui/react/combobox'
import { Search01Icon, Tick02Icon, UserStar01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { KettuRole } from '@shared/agent-host'
import type { AgentId, ConfigOption } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { AgentMarkHost } from '@renderer/components/agents/agent-mark-host'
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
  useComboboxFilter,
} from '@renderer/components/ui/combobox'
import { InputGroupAddon } from '@renderer/components/ui/input-group'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { SettingsGlyph } from '@renderer/features/account/avatar'
import { useHostLabel } from '@renderer/features/sidebar/host-label'
import { useLimitView } from '@renderer/hooks/use-limit-view'
import { errorMessage } from '@renderer/lib/host'
import { newestLimits } from '@renderer/lib/plan-readings'
import { useNow } from '@renderer/lib/use-now'
import { isSelect } from '@renderer/features/session/composer/options'
import { cn } from '@renderer/lib/utils'
import { Glyph } from '@renderer/features/shell/glyph'
import {
  agentName,
  agentsOn,
  usableAgents,
  useAgentsStore,
  usePlanReadings,
} from '@renderer/stores/agents'
import { loadKettuRoles, useKettuRoles } from '@renderer/stores/kettu-roles'
import { refreshLimits } from '@renderer/stores/usage'
import { openAgentSettings } from '@renderer/stores/view'
import { openHarnessPage } from '@renderer/features/agents/problem-fix'
import { confirmCliUpdate } from '@renderer/features/updates/command-confirm-model'
import { agentNeed, canStart, menuAgents } from './start-options'
import { agentTag, type AgentTag } from './agent-tag'
import type { LineTone } from './picker'
import { refreshOnMenu } from './prepared'
import { suggestedAgent, useRoleChoice } from './role-choice'
import { useStartModels } from './use-start-config'

const LINE_TONE: Record<LineTone, string> = {
  muted: 'text-tertiary',
  attention: 'text-attention',
  danger: 'text-danger',
}

/**
 * What stops an agent, at the end of its row; the whole sentence shows while the pointer rests on
 * it. A window's model, group or pool gives way to the agent's name first, with an ellipsis.
 */
function RowTag({ tag }: { tag: AgentTag }) {
  const { scope } = tag
  const label = scope ? (
    <span
      className={cn(
        'flex max-w-1/2 min-w-0 items-baseline pl-2 text-small whitespace-nowrap',
        LINE_TONE[tag.tone],
      )}
    >
      <span className="shrink-0 whitespace-pre">{scope.before}</span>
      <span className="min-w-0 truncate">{scope.name}</span>
      <span className="shrink-0 whitespace-pre">{scope.after}</span>
    </span>
  ) : (
    <span className={cn('shrink-0 pl-2 text-small whitespace-nowrap', LINE_TONE[tag.tone])}>
      {tag.text}
    </span>
  )
  if (!tag.title) return label
  return (
    <Tooltip>
      <TooltipTrigger render={label} />
      <TooltipContent side="top">{tag.title}</TooltipContent>
    </Tooltip>
  )
}

/** A role's row in the menu is told from an agent's by this before its reference. */
const ROLE_ROW = 'role:'

interface MenuGroup {
  value: 'roles' | 'agents'
  items: string[]
}

/** The name of the model the options start the agent with. */
function modelName(option: ConfigOption | undefined): string | null {
  if (!isSelect(option)) return null
  return option.choices.find((choice) => choice.value === option.value)?.name ?? null
}

/**
 * A role's row: its name, what it suggests (the agent, model and effort), and where it comes
 * from. A suggested agent this computer does not have is shown as written, with a tooltip.
 */
function RoleRow({
  value,
  role,
  chosen,
  hostId,
  agents,
}: {
  value: string
  role: KettuRole
  chosen: boolean
  hostId: string | null
  agents: readonly { id: AgentId }[]
}) {
  const { t } = useTranslation('session')
  const { agent, model, effort } = role.suggests
  const found = suggestedAgent(agents, agent)
  const suggests = [found ? agentName(found, hostId) : agent, model, effort].filter(Boolean)
  const source = role.origin.kind === 'plugin' ? role.origin.title : t('newSession.role.yours')
  return (
    <ComboboxItem
      value={value}
      title={agent && !found ? t('newSession.role.agentMissing', { agent }) : undefined}
      className="group/agent h-10 gap-2.5 rounded-xl py-1 pr-2 pl-2 [&>span.absolute]:hidden"
    >
      <Glyph icon={UserStar01Icon} size={16} className="shrink-0 text-secondary" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-menu text-primary">{role.title}</span>
        <span className="truncate text-small text-tertiary">
          {suggests.length > 0 ? suggests.join(' · ') : t('newSession.role.anyAgent')}
        </span>
      </span>
      <span className="max-w-1/3 shrink-0 truncate pl-2 text-small text-tertiary">{source}</span>
      {chosen && <Glyph icon={Tick02Icon} size={15} className="shrink-0 text-primary" />}
    </ComboboxItem>
  )
}

/**
 * New session's agent: a chip naming the chosen agent, and a menu of the agents it can start,
 * each a row with its mark and name and, only when something stops it, a short tag, under one
 * search. Choosing one keeps the model the agent starts with; the model has a menu of its own.
 */
export function AgentPicker({
  agentId,
  onChoose,
  onChooseRole,
  hostId = null,
}: {
  agentId: AgentId | null
  onChoose: (agentId: AgentId) => void
  /** A role was picked, or dropped when it was the one chosen; `agent` is the one it suggests here. */
  onChooseRole: (role: KettuRole, agent: AgentId | null) => void
  /** The other host New session's project is on, whose agents the menu lists; null for this computer. */
  hostId?: string | null
}) {
  const { t } = useTranslation('session')
  const hostLabel = useHostLabel(hostId)
  const now = useNow()
  const limitView = useLimitView()
  const readings = usePlanReadings()
  const statuses = useAgentsStore(
    useShallow((s) => {
      const { order, byId } = agentsOn(s, hostId)
      return menuAgents(usableAgents(order, byId), true)
    }),
  )
  // This computer's agents are read after launch: until then the list is loading, not empty.
  const agentsRead = useAgentsStore((s) => hostId !== null || s.loaded)
  const ids = useMemo(() => statuses.map((s) => s.id), [statuses])
  const startModels = useStartModels(hostId, ids)
  const byId = useMemo(() => new Map(statuses.map((s) => [s.id, s])), [statuses])
  const { contains } = useComboboxFilter()
  const [open, setOpen] = useState(false)
  const roles = useKettuRoles(hostId)
  const roleRef = useRoleChoice((s) => s.ref)
  const chosenRole = roles.find((role) => role.ref === roleRef) ?? null
  const roleByKey = useMemo(
    () => new Map(roles.map((role) => [`${ROLE_ROW}${role.ref}`, role])),
    [roles],
  )
  const groups = useMemo<MenuGroup[]>(
    () => [
      { value: 'roles', items: [...roleByKey.keys()] },
      { value: 'agents', items: ids },
    ],
    [roleByKey, ids],
  )
  useEffect(() => {
    void loadKettuRoles(hostId)
  }, [hostId])

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) return
    void loadKettuRoles(hostId)
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

  const agentRow = (id: AgentId) => {
    const status = byId.get(id)
    if (!status) return null
    const tag = agentTag(status, {
      now,
      view: limitView,
      limits: newestLimits(readings, status),
      model: startModels.get(id),
    })
    return (
      <ComboboxItem
        key={id}
        value={id}
        aria-label={
          tag
            ? t('newSession.picker.rowState', {
                name: status.name,
                state: tag.title ?? tag.text,
              })
            : undefined
        }
        className="group/agent h-8 gap-2.5 rounded-xl py-1 pr-2 pl-2 [&>span.absolute]:hidden"
      >
        <AgentMark agent={id} size={16} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-menu text-primary">{status.name}</span>
        {tag && <RowTag tag={tag} />}
        {id === agentId && <Glyph icon={Tick02Icon} size={15} className="shrink-0 text-primary" />}
      </ComboboxItem>
    )
  }

  return (
    // Marks inside show this host's agents, the second-account dots included.
    <AgentMarkHost.Provider value={hostId}>
      <Combobox
        items={groups}
        value={agentId}
        open={open}
        onOpenChange={onOpenChange}
        onValueChange={(value: string | null, details) => {
          if (!value) return
          const role = roleByKey.get(value)
          if (role) {
            onChooseRole(role, suggestedAgent(statuses.filter(canStart), role.suggests.agent))
            return
          }
          const id = value as AgentId
          const status = byId.get(id)
          // An agent whose own program is too old is not chosen: a click updates it, once its
          // command is shown. One that cannot run for another reason opens its harness's page,
          // where that is fixed.
          const need = status ? agentNeed(status) : null
          if (status && need === 'update') {
            if (status.cli?.update && hostId === null) {
              details.cancel()
              setOpen(false)
              void confirmCliUpdate(status)
            } else {
              setOpen(false)
              openHarnessPage(status, hostId)
            }
            return
          }
          if (status && need === 'blocked') {
            details.cancel()
            setOpen(false)
            openHarnessPage(status, hostId)
            return
          }
          onChoose(id)
        }}
        itemToStringLabel={(value: string) =>
          roleByKey.get(value)?.title ?? agentName(value as AgentId, hostId)
        }
        filter={(value: string, query: string) => {
          const role = roleByKey.get(value)
          if (role) return contains(`${role.title} ${role.description}`, query)
          const status = byId.get(value as AgentId)
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
          {agentId && chosenRole ? (
            <>
              <Glyph icon={UserStar01Icon} size={13} className="shrink-0" />
              <span className="kettu-tray-link__text" title={chosenRole.title}>
                {chosenRole.title}
              </span>
              <span className="text-tertiary">·</span>
              <AgentMark agent={agentId} size={13} className="shrink-0" />
              <span className="kettu-tray-link__text" title={agentName(agentId, hostId)}>
                {modelName(startModels.get(agentId)) ?? agentName(agentId, hostId)}
              </span>
            </>
          ) : agentId ? (
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
                <Skeleton key={i} className="h-8 w-full rounded-xl" />
              ))}
            </div>
          ) : statuses.length === 0 ? (
            <p className="px-3.5 py-3 text-ui text-muted-foreground">
              {hostId === null
                ? t('newSession.noAgent')
                : t('newSession.noAgentOnHost', { host: hostLabel })}
            </p>
          ) : (
            <ComboboxList
              className="max-h-[min(--spacing(110),calc(var(--available-height)---spacing(24)))] scroll-fade-y px-1.5 pt-0.5 pb-1.5"
              highlight="rounded-xl"
            >
              {(group: MenuGroup) =>
                group.items.length > 0 && (
                  <ComboboxGroup key={group.value} items={group.items}>
                    {roles.length > 0 && (
                      <ComboboxLabel className="h-6.5 text-small">
                        {t(
                          group.value === 'roles'
                            ? 'newSession.role.group'
                            : 'newSession.role.agents',
                        )}
                      </ComboboxLabel>
                    )}
                    <ComboboxCollection>
                      {(value: string) => {
                        const role = roleByKey.get(value)
                        return role ? (
                          <RoleRow
                            key={value}
                            value={value}
                            role={role}
                            chosen={role.ref === roleRef}
                            hostId={hostId}
                            agents={statuses.filter(canStart)}
                          />
                        ) : (
                          agentRow(value as AgentId)
                        )
                      }}
                    </ComboboxCollection>
                  </ComboboxGroup>
                )
              }
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
