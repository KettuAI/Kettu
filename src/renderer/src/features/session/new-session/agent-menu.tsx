import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentStatus } from '@shared/agent-host'
import { ULTRACODE_OPTION_ID, type AgentId, type ConfigOption } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
  useComboboxFilter,
} from '@renderer/components/ui/combobox'
import { Separator } from '@renderer/components/ui/separator'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { Switch } from '@renderer/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { ChoiceName, EffortSegments } from '@renderer/features/session/composer/control-row'
import {
  levelsOf,
  splitName,
  tierOf,
  type SelectOption,
} from '@renderer/features/session/composer/levels'
import { listedInstalled } from '@renderer/features/agents/readiness'
import { Ring } from '@renderer/features/session/composer/usage'
import {
  countdown,
  tightestLimit,
  USAGE_TONE_TEXT,
  usageTone,
} from '@renderer/features/sidebar/plan-usage'
import { limitLabel } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useAgentOptionsStore } from '@renderer/stores/agent-options'
import { agentName, usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { refreshLimits } from '@renderer/stores/usage'
import { openAgentSettings } from '@renderer/stores/view'
import {
  agentNeed,
  canStart,
  itemKey,
  menuGroups,
  parseItemKey,
  preparedConfig,
  startConfig,
  type MenuAgent,
  type MenuGroup,
} from './start-options'
import { refreshOnMenu, retryPrepare, setOption } from './prepared'
import { useStartConfig } from './use-start-config'

const isSelect = (o: ConfigOption | undefined): o is SelectOption =>
  !!o && o.type === 'select' && !!o.choices?.length

/** The installed agents first, each group in catalog order, as Settings › Agents lists them. */
function menuOrder(statuses: AgentStatus[]): AgentStatus[] {
  return [...statuses.filter(listedInstalled), ...statuses.filter((s) => !listedInstalled(s))]
}

/**
 * The composer's agent-and-model button and its menu: the agents on a rail, the shown agent's
 * models with its reasoning level and switches beside them, and one search over both. Choosing a
 * model chooses its agent with it.
 */
export function AgentMenu({
  agentId,
  onChoose,
}: {
  agentId: AgentId | null
  onChoose: (agentId: AgentId, model: string | null) => void
}) {
  const { t } = useTranslation('session')
  const statuses = useAgentsStore(useShallow((s) => menuOrder(usableAgents(s.order, s.byId))))
  const entries = useAgentOptionsStore((s) => s.byId)
  const picks = useAgentOptionsStore((s) => s.picks)
  const loaded = useAgentOptionsStore((s) => s.loaded)
  const prepared = useAgentOptionsStore((s) => s.prepared)
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState<AgentId | null>(agentId)
  const shownPrepared = shown && prepared?.agentId === shown ? prepared : null
  const [query, setQuery] = useState('')
  const { contains } = useComboboxFilter()
  const body = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<number | null>(null)

  const configs = useMemo(() => {
    const map = new Map<AgentId, ConfigOption[]>()
    for (const status of statuses) {
      const entry = entries[status.id]
      const live = prepared?.agentId === status.id ? prepared.summary?.prepared : undefined
      if (live)
        map.set(status.id, preparedConfig(live.config, entry?.levels ?? {}, picks[status.id]))
      else if (entry) map.set(status.id, startConfig(entry, picks[status.id]))
    }
    return map
  }, [statuses, entries, picks, prepared])
  const agents: MenuAgent[] = statuses.map((status) => {
    const model = configs.get(status.id)?.find((o) => o.category === 'model')
    return {
      agentId: status.id,
      name: status.name,
      model: isSelect(model) ? model : null,
      choosable: canStart(status),
    }
  })
  const groups = menuGroups(agents, shown, query, contains)
  // Every item, so the chosen one's label resolves while the list shows another agent.
  const allGroups = useMemo<MenuGroup[]>(
    () =>
      agents.map((a) => ({
        agentId: a.agentId,
        items: a.model?.choices?.length
          ? a.model.choices.map((c) => itemKey(a.agentId, c.value))
          : [itemKey(a.agentId, null)],
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- agents is derived from these
    [statuses, configs],
  )
  const chosenModel = agentId ? agents.find((a) => a.agentId === agentId)?.model : null
  const value = agentId ? itemKey(agentId, chosenModel ? String(chosenModel.value) : null) : null
  const searching = query.trim().length > 0
  const visibleRail = searching
    ? statuses.filter((s) => groups.some((g) => g.agentId === s.id))
    : statuses

  const label = (key: string) => {
    const { agentId: id, model } = parseItemKey(key)
    const choice = agents
      .find((a) => a.agentId === id)
      ?.model?.choices?.find((c) => c.value === model)
    return choice ? `${agentName(id)} ${choice.name}` : agentName(id)
  }

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) {
      setQuery('')
      setHeight(null)
      return
    }
    setShown(
      agentId ??
        (statuses.find(listedInstalled) ?? statuses.find(canStart) ?? statuses[0])?.id ??
        null,
    )
    for (const status of statuses) {
      if (status.state !== 'ready' || !status.capabilities.reports) continue
      refreshLimits(status.id).catch((error: unknown) =>
        console.warn(`Could not read the plan limits: ${errorMessage(error)}`),
      )
    }
    refreshOnMenu(statuses.filter((s) => s.state === 'ready').map((s) => s.id))
  }

  // The menu keeps the size it opened with while a search narrows it, so nothing jumps.
  useLayoutEffect(() => {
    if (open && !searching && body.current) setHeight(body.current.offsetHeight)
  }, [open, searching, shown])

  const close = () => onOpenChange(false)

  return (
    <Combobox
      items={allGroups}
      filteredItems={groups}
      filter={null}
      value={value}
      onValueChange={(key: string | null) => {
        if (!key) return
        const choice = parseItemKey(key)
        onChoose(choice.agentId, choice.model)
      }}
      open={open}
      onOpenChange={onOpenChange}
      inputValue={query}
      onInputValueChange={setQuery}
      itemToStringLabel={label}
      autoHighlight
    >
      <ComboboxTrigger
        render={
          <Button
            variant="quiet"
            size="compact"
            aria-label={t('newSession.agentMenu.label')}
            className="min-w-0 shrink gap-1.5 px-2"
          />
        }
      >
        <AgentButtonLabel agentId={agentId} />
      </ComboboxTrigger>
      <ComboboxContent sideOffset={6} className="flex flex-col">
        <ComboboxInput
          showTrigger={false}
          placeholder={t('newSession.agentMenu.search')}
          aria-label={t('newSession.agentMenu.search')}
          spellCheck={false}
        />
        <Tabs
          orientation="vertical"
          value={shown}
          onValueChange={(next: AgentId) => {
            setShown(next)
            setQuery('')
          }}
          className="min-h-0 flex-1 flex-row gap-0"
        >
          <div
            ref={body}
            className="flex min-h-0 flex-1"
            style={searching && height ? { minHeight: height } : undefined}
          >
            <TabsList
              variant="rail"
              activateOnFocus
              aria-label={t('newSession.agentMenu.agents')}
              className="max-h-[min(--spacing(96),calc(var(--available-height)---spacing(9)))] w-auto min-w-44 shrink-0 scroll-fade-y justify-start overflow-y-auto overscroll-contain p-1.5"
            >
              {visibleRail.map((status) => (
                <RailRow key={status.id} status={status} />
              ))}
            </TabsList>
            <Separator orientation="vertical" className="bg-border-soft" />
            <TabsContent
              value={shown ?? undefined}
              tabIndex={-1}
              keepMounted={false}
              className="flex w-80 min-w-0 flex-col"
            >
              <Pane
                status={statuses.find((s) => s.id === shown) ?? null}
                config={shown ? (configs.get(shown) ?? null) : null}
                loaded={loaded}
                opening={shownPrepared?.opening ?? false}
                failure={shownPrepared?.error ?? null}
                searching={searching}
                groups={groups}
                agents={agents}
                onLeave={close}
              />
            </TabsContent>
          </div>
        </Tabs>
      </ComboboxContent>
    </Combobox>
  )
}

/** What the composer's button shows: the agent, the model it starts with and the level. */
function AgentButtonLabel({ agentId }: { agentId: AgentId | null }) {
  const { t } = useTranslation('session')
  const config = useStartConfig(agentId)
  if (!agentId) {
    return <span className="truncate text-foreground">{t('newSession.chooseAgentShort')}</span>
  }
  const model = config?.find((o) => o.category === 'model')
  const effort = config?.find((o) => o.category === 'thought_level')
  const modelName = isSelect(model)
    ? (model.choices.find((c) => c.value === model.value)?.name ?? String(model.value))
    : null
  const level = isSelect(effort) ? levelsOf(effort, String(effort.value)) : null
  const levelName = isSelect(effort)
    ? effort.choices.find((c) => c.value === effort.value)?.name
    : undefined
  return (
    <>
      <AgentMark agent={agentId} size={14} />
      <span className="shrink-0 font-medium text-foreground">{agentName(agentId)}</span>
      {modelName && (
        <span className="min-w-0 truncate text-secondary" title={modelName}>
          {splitName(modelName)[1]}
        </span>
      )}
      {levelName && !(modelName && level?.usesDefault) && (
        <span className="shrink-0 text-secondary">{levelName}</span>
      )}
    </>
  )
}

/** One agent on the rail: its mark and name, then its plan usage or what it needs. */
function RailRow({ status }: { status: AgentStatus }) {
  const { t } = useTranslation('session')
  const now = useNow()
  const limit = tightestLimit(status.limits, now)
  const need = agentNeed(status)
  const trailing =
    need === 'install' || need === 'adapter'
      ? t('newSession.agentMenu.notInstalled')
      : need === 'setup'
        ? t('newSession.agentMenu.setsUp')
        : need === 'installing'
          ? t('newSession.agentMenu.installing')
          : need === 'failed'
            ? t('newSession.agentMenu.failed')
            : need === 'sign-in'
              ? t('newSession.agentMenu.signIn')
              : null

  return (
    <TabsTrigger value={status.id} className="justify-start gap-2">
      <AgentMark agent={status.id} size={14} />
      <span className="min-w-0 flex-1 truncate text-left">{status.name}</span>
      {trailing ? (
        <span className="shrink-0 pl-2 text-xs text-muted-foreground">{trailing}</span>
      ) : (
        limit && <UsageNote limits={status.limits} now={now} />
      )}
    </TabsTrigger>
  )
}

/** The tightest window's pie and percentage, with every window in the tooltip. */
function UsageNote({ limits, now }: { limits: AgentStatus['limits']; now: number }) {
  const { t } = useTranslation('session')
  const limit = tightestLimit(limits, now)
  if (!limit) return null
  const tone = usageTone(limit)
  const percent = limit.usedPercent === null ? null : Math.round(limit.usedPercent)
  const current = limits.filter((l) => l.resetsAt === null || l.resetsAt > now)
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              'flex shrink-0 items-center gap-1 pl-2 text-xs tabular',
              USAGE_TONE_TEXT[tone],
            )}
          />
        }
      >
        <Ring share={(limit.usedPercent ?? 0) / 100} tone={tone} className="size-3" />
        {percent === null ? '—' : `${percent}%`}
      </TooltipTrigger>
      <TooltipContent side="right" className="flex flex-col items-start gap-0.5">
        {current.map((l) => {
          const left = l.resetsAt ? countdown(l.resetsAt - now) : null
          const used = l.usedPercent === null ? '—' : `${Math.round(l.usedPercent)}%`
          return (
            <span key={l.window} className="tabular">
              {left
                ? t('newSession.agentMenu.windowResets', { limit: limitLabel(l), used, left })
                : t('newSession.agentMenu.window', { limit: limitLabel(l), used })}
            </span>
          )
        })}
      </TooltipContent>
    </Tooltip>
  )
}

/** The right side: the shown agent's models, level and switches, or the search's results. */
function Pane({
  status,
  config,
  loaded,
  opening,
  failure,
  searching,
  groups,
  agents,
  onLeave,
}: {
  status: AgentStatus | null
  config: ConfigOption[] | null
  loaded: boolean
  /** The agent's prepared session is opening, so what shows may still change. */
  opening: boolean
  /** Why the agent's prepared session could not open. */
  failure: string | null
  searching: boolean
  groups: MenuGroup[]
  agents: MenuAgent[]
  onLeave: () => void
}) {
  const { t } = useTranslation('session')
  if (!status) return null
  const name = status.name
  const need = agentNeed(status)
  const installed = need !== 'install'
  // The options load with the list, and with a start until the agent has reported them.
  const startingUp = loaded && !config && (opening || status.state === 'starting')
  const loading = !loaded || startingUp
  const model = config?.find((o) => o.category === 'model')
  const effort = config?.find((o) => o.category === 'thought_level')
  const highTier = isSelect(effort) && effort.choices.some((c) => tierOf(effort, c.value) !== null)
  const switches =
    config?.filter(
      (o) => o.type === 'boolean' && (o.id !== ULTRACODE_OPTION_ID || highTier || o.value === true),
    ) ?? []

  const install = (
    <Button
      variant="outline"
      size="xs"
      onClick={() => {
        onLeave()
        openAgentSettings(status.id)
      }}
    >
      {t('newSession.agentMenu.install')}
    </Button>
  )
  let notice = null
  if (!searching) {
    if (need === 'install') {
      notice = (
        <Notice text={t('newSession.agentMenu.notInstalledLong', { agent: name })}>
          {install}
        </Notice>
      )
    } else if (need === 'adapter') {
      notice = (
        <Notice text={t('newSession.agentMenu.installsOnFirstUse', { agent: name })}>
          {install}
        </Notice>
      )
    } else if (need === 'setup') {
      notice = (
        <Notice
          text={t('newSession.agentMenu.setsUpLong', { agent: name, command: status.cli?.command })}
        >
          {install}
        </Notice>
      )
    } else if (need === 'failed') {
      notice = (
        <Notice text={status.detail ?? t('newSession.agentMenu.failedLong', { agent: name })} error>
          <Button
            variant="outline"
            size="xs"
            onClick={() =>
              void host('agents.retry', { agentId: status.id }).catch((error: unknown) =>
                console.warn(`Could not retry ${status.id}: ${errorMessage(error)}`),
              )
            }
          >
            {t('newSession.agentMenu.retry')}
          </Button>
        </Notice>
      )
    } else if (need === 'sign-in') {
      notice = (
        <Notice text={t('newSession.agentMenu.signInLong', { agent: name })}>
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              onLeave()
              openAgentSettings(status.id)
            }}
          >
            {t('newSession.agentMenu.signInAction')}
          </Button>
        </Notice>
      )
    } else if (failure && !opening) {
      notice = (
        <Notice
          text={t('newSession.agentMenu.prepareFailed', { agent: name, error: failure })}
          error
        >
          <Button variant="outline" size="xs" onClick={retryPrepare}>
            {t('newSession.agentMenu.retry')}
          </Button>
        </Notice>
      )
    } else if (!loading && !config) {
      notice = <Notice text={t('newSession.agentMenu.modelsOnStart', { agent: name })} />
    }
  }

  return (
    <>
      {notice}
      {!searching && installed && startingUp && (
        // Words once a start takes longer than a moment; the space is kept, so nothing shifts.
        <div
          role="status"
          className="flex animate-in items-center gap-1.5 px-3.5 pt-2.5 pb-1.5 text-xs text-muted-foreground fade-in fill-mode-backwards delay-1000 animation-duration-(--duration-base)"
        >
          <Spinner
            className={cn('size-3 shrink-0', status.state === 'installing' && 'text-info')}
          />
          <span className="truncate shimmer">
            {t(status.state === 'installing' ? 'agentStart.installing' : 'agentStart.starting', {
              agent: name,
            })}
          </span>
        </div>
      )}
      {!searching && installed && config && opening && (
        // The cached models stand in until the prepared session answers.
        <div
          role="status"
          className="flex animate-in items-center gap-1.5 px-3.5 pt-2.5 pb-1.5 text-xs text-muted-foreground fade-in fill-mode-backwards delay-1000 animation-duration-(--duration-base)"
        >
          <Spinner className="size-3 shrink-0" />
          <span className="truncate shimmer">
            {t('newSession.agentMenu.checking', { agent: name })}
          </span>
        </div>
      )}
      {!searching && installed && loading ? (
        <div
          className="flex animate-in flex-col gap-1 p-1.5 fade-in fill-mode-backwards delay-200 animation-duration-(--duration-base)"
          aria-hidden
        >
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-row w-full rounded-lg" />
          ))}
        </div>
      ) : (
        <ComboboxList className="max-h-72 scroll-fade-y">
          {(group: MenuGroup) => (
            <ModelGroup
              key={group.agentId}
              group={group}
              agent={agents.find((a) => a.agentId === group.agentId)}
              searching={searching}
            />
          )}
        </ComboboxList>
      )}
      {searching && groups.length === 0 && (
        <p className="px-3.5 py-2 text-ui text-muted-foreground">
          {t('newSession.agentMenu.noMatch')}
        </p>
      )}
      {!searching && installed && config && (isSelect(effort) || switches.length > 0) && (
        <div className="flex flex-col p-1.5 pt-0">
          {isSelect(effort) && (
            <>
              {isSelect(model) && <ComboboxSeparator className="mt-0" />}
              <EffortSegments
                effort={effort}
                value={String(effort.value)}
                onPick={(v) => setOption(status.id, effort.id, v)}
                plain
              />
            </>
          )}
          {switches.length > 0 && (
            <>
              <ComboboxSeparator />
              {switches.map((o) => (
                <SwitchRow key={o.id} agentId={status.id} option={o} />
              ))}
            </>
          )}
        </div>
      )}
    </>
  )
}

function ModelGroup({
  group,
  agent,
  searching,
}: {
  group: MenuGroup
  agent: MenuAgent | undefined
  searching: boolean
}) {
  const { t } = useTranslation('session')
  if (!agent) return null
  const choices = agent.model?.choices ?? []
  return (
    <ComboboxGroup items={group.items}>
      {searching ? (
        <ComboboxLabel className="flex items-center gap-1.5">
          <AgentMark agent={agent.agentId} size={12} />
          {agent.name}
        </ComboboxLabel>
      ) : (
        agent.model && <ComboboxLabel>{agent.model.name}</ComboboxLabel>
      )}
      <ComboboxCollection>
        {(key: string) => {
          const { model } = parseItemKey(key)
          const choice = choices.find((c) => c.value === model)
          return choice ? (
            <Tooltip key={key}>
              <TooltipTrigger render={<ComboboxItem value={key} className="items-center" />}>
                <ChoiceName name={choice.name} className="flex-1" />
              </TooltipTrigger>
              {choice.description && (
                <TooltipContent side="right">{choice.description}</TooltipContent>
              )}
            </Tooltip>
          ) : (
            <ComboboxItem key={key} value={key} className="items-center">
              <span className="min-w-0 flex-1 truncate font-medium">
                {t('newSession.agentMenu.useAgent', { agent: agent.name })}
              </span>
            </ComboboxItem>
          )
        }}
      </ComboboxCollection>
    </ComboboxGroup>
  )
}

/** A line about the shown agent above its models, with the action that helps. */
function Notice({
  text,
  error = false,
  children,
}: {
  text: string
  error?: boolean
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col items-start gap-2 px-3.5 pt-2.5 pb-1.5">
      <p className={cn('text-xs', error ? 'text-danger' : 'text-muted-foreground')}>{text}</p>
      {children}
    </div>
  )
}

/** A boolean option as a menu row; it sets what the agent starts with and keeps the menu open. */
function SwitchRow({ agentId, option }: { agentId: AgentId; option: ConfigOption }) {
  const id = `${agentId}-${option.id}`
  return (
    <label
      htmlFor={id}
      className="flex min-h-row cursor-default items-center gap-2 rounded-lg px-2 py-1 text-ui hover:bg-hover"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">{option.name}</span>
        {option.description && (
          <span className="text-xs text-muted-foreground">{option.description}</span>
        )}
      </span>
      <Switch
        id={id}
        size="sm"
        checked={option.value === true}
        onCheckedChange={(checked) => setOption(agentId, option.id, checked)}
      />
    </label>
  )
}
