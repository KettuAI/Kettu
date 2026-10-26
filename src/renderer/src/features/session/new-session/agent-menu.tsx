import { useMemo, useRef, useState, type ReactNode } from 'react'
import { SearchIcon } from 'lucide-react'
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
import { InputGroupAddon } from '@renderer/components/ui/input-group'
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
import { useAgentOptionsStore, type OptionValues } from '@renderer/stores/agent-options'
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
  values,
  onValues,
}: {
  agentId: AgentId | null
  onChoose: (agentId: AgentId, model: string | null) => void
  /**
   * The option values of the menu's own agent, when the caller keeps them itself, as a routine
   * does; without them the menu shows and sets New session's picks.
   */
  values?: OptionValues
  /** With `values`, each change to them; the caller saves it. */
  onValues?: (optionId: string, value: string | boolean) => void
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
  const rail = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ rail: number; height: number } | null>(null)

  const configs = useMemo(() => {
    const map = new Map<AgentId, ConfigOption[]>()
    for (const status of statuses) {
      const entry = entries[status.id]
      const live = prepared?.agentId === status.id ? prepared.summary?.prepared : undefined
      const own = values && status.id === agentId ? values : picks[status.id]
      if (live) map.set(status.id, preparedConfig(live.config, entry?.levels ?? {}, own))
      else if (entry) map.set(status.id, startConfig(entry, own))
    }
    return map
  }, [statuses, entries, picks, prepared, values, agentId])
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
      setSize(null)
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

  // The rail and the pane keep the sizes they had while a search narrows them, so nothing jumps.
  const onQuery = (next: string) => {
    if (!searching && next.trim() && body.current && rail.current) {
      setSize({ rail: rail.current.offsetWidth, height: body.current.offsetHeight })
    }
    setQuery(next)
  }

  const close = () => onOpenChange(false)

  // A caller that keeps the values itself hears of the changes to its own agent; another agent's
  // changes are only a look at it until one of its models is chosen.
  const pickOption = (id: AgentId, optionId: string, value: string | boolean) => {
    if (onValues && id === agentId) onValues(optionId, value)
    else setOption(id, optionId, value)
  }

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
      onInputValueChange={onQuery}
      itemToStringLabel={label}
      autoHighlight
    >
      <ComboboxTrigger
        render={
          <Button
            variant="quiet"
            size="sm"
            aria-label={t('newSession.agentMenu.label')}
            className="min-w-0 shrink gap-1 overflow-hidden px-2.25 text-control font-normal has-data-[icon=inline-end]:pr-2.25"
          />
        }
      >
        <AgentButtonLabel agentId={agentId} values={values} />
      </ComboboxTrigger>
      <ComboboxContent
        align="end"
        sideOffset={6}
        className="flex min-h-[min(--spacing(75),var(--available-height))] flex-col"
      >
        <ComboboxInput
          showTrigger={false}
          placeholder={t('newSession.agentMenu.search')}
          aria-label={t('newSession.agentMenu.search')}
          spellCheck={false}
        >
          <InputGroupAddon>
            <SearchIcon className="size-3.5" />
          </InputGroupAddon>
        </ComboboxInput>
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
            className="flex min-h-0 flex-1 p-1.5"
            style={searching && size ? { minHeight: size.height } : undefined}
          >
            <TabsList
              ref={rail}
              style={searching && size ? { minWidth: size.rail } : undefined}
              variant="rail"
              activateOnFocus
              aria-label={t('newSession.agentMenu.agents')}
              className="max-h-[min(--spacing(96),calc(var(--available-height)---spacing(12)))] w-auto min-w-49 shrink-0 scroll-fade-y justify-start overflow-y-auto overscroll-contain pr-1.5"
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
              className="ml-1.5 flex w-80 min-w-0 flex-col"
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
                onOption={pickOption}
              />
            </TabsContent>
          </div>
        </Tabs>
      </ComboboxContent>
    </Combobox>
  )
}

/** What the composer's button shows: the agent, the model it starts with and the level. */
function AgentButtonLabel({ agentId, values }: { agentId: AgentId | null; values?: OptionValues }) {
  const { t } = useTranslation('session')
  const config = useStartConfig(agentId, values)
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
      {/* On a narrow window the model's name gives way first, the agent's only after it. */}
      <span className="min-w-0 truncate text-foreground" title={agentName(agentId)}>
        {agentName(agentId)}
      </span>
      {modelName && (
        <span className="min-w-0 shrink-100 truncate text-secondary" title={modelName}>
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
    <TabsTrigger
      value={status.id}
      // The shown agent takes the selected fill, as a menu's rail does.
      className="justify-start gap-2 rounded-md group-data-[variant=rail]/tabs-list:data-active:bg-selected dark:group-data-[variant=rail]/tabs-list:data-active:bg-selected"
    >
      <AgentMark agent={status.id} size={14} />
      <span className="min-w-0 flex-1 truncate text-left">{status.name}</span>
      {trailing ? (
        <span
          className={cn(
            'shrink-0 pl-2 text-xs',
            need === 'sign-in'
              ? 'text-warning'
              : need === 'failed'
                ? 'text-danger'
                : 'text-muted-foreground',
          )}
        >
          {trailing}
        </span>
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
              'flex shrink-0 items-center gap-1.25 pl-2 text-xs tabular',
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
  onOption,
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
  /** Where an option's change goes: New session's picks, or the caller's own values. */
  onOption: (agentId: AgentId, optionId: string, value: string | boolean) => void
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
        <Notice text={t('newSession.agentMenu.notInstalledLong', { agent: name })} tone="neutral">
          {install}
        </Notice>
      )
    } else if (need === 'adapter') {
      notice = (
        <Notice text={t('newSession.agentMenu.installsOnFirstUse', { agent: name })} tone="neutral">
          {install}
        </Notice>
      )
    } else if (need === 'setup') {
      notice = (
        <Notice
          text={t('newSession.agentMenu.setsUpLong', { agent: name, command: status.cli?.command })}
          tone="neutral"
        >
          {install}
        </Notice>
      )
    } else if (need === 'failed') {
      notice = (
        <Notice
          text={status.detail ?? t('newSession.agentMenu.failedLong', { agent: name })}
          tone="danger"
        >
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
        <Notice text={t('newSession.agentMenu.signInLong', { agent: name })} tone="warning">
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
          tone="danger"
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
          className="flex animate-in items-center gap-1.5 px-2 pt-2 pb-1.5 text-xs text-muted-foreground fade-in fill-mode-backwards delay-1000 animation-duration-(--duration-base)"
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
          className="flex animate-in items-center gap-1.5 px-2 pt-2 pb-1.5 text-xs text-muted-foreground fade-in fill-mode-backwards delay-1000 animation-duration-(--duration-base)"
        >
          <Spinner className="size-3 shrink-0" />
          <span className="truncate shimmer">
            {t('newSession.agentMenu.checking', { agent: name })}
          </span>
        </div>
      )}
      {!searching && installed && loading ? (
        <div
          className="flex animate-in flex-col gap-1 fade-in fill-mode-backwards delay-200 animation-duration-(--duration-base)"
          aria-hidden
        >
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-row w-full rounded-md" />
          ))}
        </div>
      ) : (
        <ComboboxList className="max-h-72 scroll-fade-y scroll-py-0 p-0">
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
        <p className="px-2 py-5 text-center text-small text-muted-foreground">
          {t('newSession.agentMenu.noMatch')}
        </p>
      )}
      {!searching && installed && config && (isSelect(effort) || switches.length > 0) && (
        <div className="flex flex-col">
          {isSelect(effort) && (
            <>
              {isSelect(model) && <ComboboxSeparator />}
              <EffortSegments
                effort={effort}
                value={String(effort.value)}
                onPick={(v) => onOption(status.id, effort.id, v)}
                plain
              />
            </>
          )}
          {switches.length > 0 && (
            <>
              <ComboboxSeparator />
              {switches.map((o) => (
                <SwitchRow
                  key={o.id}
                  agentId={status.id}
                  option={o}
                  onChange={(value) => onOption(status.id, o.id, value)}
                />
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
                <ChoiceName name={choice.name} className="flex-1 font-normal" />
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

const NOTICE_TONE = {
  warning: 'bg-warning-tint text-foreground',
  danger: 'bg-danger-tint text-danger',
  neutral: 'bg-subtle text-foreground',
} as const

/**
 * A line about the shown agent above its models: on a tint by what it asks of you, with the action
 * that helps, or plain when it only says what comes next.
 */
function Notice({
  text,
  tone,
  children,
}: {
  text: string
  tone?: keyof typeof NOTICE_TONE
  children?: ReactNode
}) {
  if (!tone) return <p className="px-2 pt-2 pb-1.5 text-xs text-muted-foreground">{text}</p>
  return (
    <div
      className={cn(
        'mx-0.5 mt-0.5 mb-1.5 flex items-center gap-2 rounded-md py-2 pr-2 pl-2.5 text-small',
        NOTICE_TONE[tone],
      )}
    >
      <p className="min-w-0 flex-1">{text}</p>
      {children}
    </div>
  )
}

/** A boolean option as a menu row; it sets what the agent starts with and keeps the menu open. */
function SwitchRow({
  agentId,
  option,
  onChange,
}: {
  agentId: AgentId
  option: ConfigOption
  onChange: (value: boolean) => void
}) {
  const id = `${agentId}-${option.id}`
  return (
    <label
      htmlFor={id}
      className="flex min-h-11 cursor-default items-center gap-2 rounded-md px-2 py-1.25 text-ui hover:bg-hover"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span>{option.name}</span>
        {option.description && (
          <span className="text-xs text-muted-foreground">{option.description}</span>
        )}
      </span>
      <Switch id={id} checked={option.value === true} onCheckedChange={onChange} />
    </label>
  )
}
