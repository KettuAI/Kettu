import {
  useCallback,
  useId,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Combobox as ComboboxPrimitive } from '@base-ui/react/combobox'
import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import {
  CheckIcon,
  ChevronDownIcon,
  EyeIcon,
  GaugeIcon,
  PencilIcon,
  RotateCcwIcon,
  SearchIcon,
  ShieldCheckIcon,
  ShieldIcon,
  SparkleIcon,
  TriangleAlertIcon,
  ZapIcon,
} from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { cacheExpiry } from '@shared/prompt-cache'
import { ULTRACODE_OPTION_ID, type ConfigOption, type SessionView } from '@shared/thread'
import { SegmentedControl } from '@renderer/components/segmented-control'
import { Button } from '@renderer/components/ui/button'
import {
  Combobox,
  ComboboxCollection,
  ComboboxItem,
  ComboboxList,
  useComboboxFilter,
} from '@renderer/components/ui/combobox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuList,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Kbd } from '@renderer/components/ui/kbd'
import { Switch } from '@renderer/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { errorMessage, host } from '@renderer/lib/host'
import { formatShortcut } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { useAgentsStore } from '@renderer/stores/agents'
import { levelRows, levelsOf, splitName, tierOf, type SelectOption } from './levels'
import { CheckColumn, DESCRIBED_ROW, ItemText, ROW_BUTTON } from './menu-parts'
import { mainModels, numberedModel, shownChoice, shownValue, splitModels } from './model-list'
import { modeLook } from './modes'
import { CacheButton, ContextButton } from './usage'

/** Asks the agent to change an option; resolves to whether it did. */
type Select = (optionId: string, value: string | boolean) => Promise<boolean>

const isSelect = (o: ConfigOption): o is SelectOption => o.type === 'select' && !!o.choices?.length

function choiceName(option: SelectOption, value: string | undefined): string {
  return shownChoice(option.choices, value)?.name ?? String(value)
}

// How long a pick may stand in for the agent's value when no new value arrives.
const SETTLE_MS = 1500

/**
 * The option's value, showing the user's pick at once. The agent's new value arrives with the
 * session's next patch, after the request has settled, so the pick stands until that value lands,
 * the request fails or `SETTLE_MS` passes.
 */
function usePick(
  option: SelectOption | undefined,
  onSelect: Select,
): [string | undefined, (value: string) => void] {
  const actual = option === undefined ? undefined : String(option.value)
  const [pending, setPending] = useState<string | null>(null)
  if (pending !== null && pending === actual) setPending(null)
  const shown = pending ?? actual
  const pick = (value: string) => {
    if (!option || value === shown) return
    setPending(value)
    const clear = () => setPending((p) => (p === value ? null : p))
    void onSelect(option.id, value).then((ok) => {
      if (ok) setTimeout(clear, SETTLE_MS)
      else clear()
    })
  }
  return [shown, pick]
}

/** The session's controls under the composer, built from the agent's config options. */
export function ControlRow({
  session,
  addMenu,
  onCompact,
  ultracode = false,
  modelMenu,
  outOfCredit = false,
}: {
  session: SessionView
  /** **+**, first in the row. */
  addMenu: ReactNode
  onCompact: (() => void) | null
  /** The draft turns on Claude Code's ultracode for its message. */
  ultracode?: boolean
  /** The model menu's open state, so the out-of-credit strip can open it. */
  modelMenu: { open: boolean; onOpenChange: (open: boolean) => void }
  /** The model's provider refused the latest turn for want of credit. */
  outOfCredit?: boolean
}) {
  const agent = useAgentsStore((s) => s.byId[session.agentId])
  const [error, setError] = useState<string | null>(null)
  const config = session.config
  const mode = config.find((o) => o.category === 'mode' && isSelect(o)) as SelectOption | undefined
  const model = config.find((o) => o.category === 'model' && isSelect(o)) as
    SelectOption | undefined
  const effort = config.find((o) => o.category === 'thought_level' && isSelect(o)) as
    SelectOption | undefined
  const running = session.status === 'running' || session.status === 'awaiting_permission'
  // Ultracode takes effect only with a model that offers the high tier (xhigh), so the switch
  // shows only then, or while it is on.
  const highTier = !!effort && effort.choices.some((c) => tierOf(effort, c.value) !== null)
  const ultracodeOn = config.some((o) => o.id === ULTRACODE_OPTION_ID && o.value === true)
  const switches = config.filter(
    (o) => o.type === 'boolean' && (o.id !== ULTRACODE_OPTION_ID || highTier || o.value === true),
  )
  const others = config.filter(
    (o): o is SelectOption => isSelect(o) && o !== mode && o !== model && o !== effort,
  )
  const leftOthers = others.filter((o) => o.category === 'other')
  const rightOthers = others.filter((o) => o.category !== 'other')

  const cache = cacheExpiry(session, agent?.account ?? null)
  const timed = cache?.expiresAt != null ? cache : null
  const warns = agent?.limits.some((l) => l.state !== 'ok') ?? false

  const set: Select = (optionId, value) => {
    setError(null)
    return host('sessions.setConfigOption', { sessionId: session.id, optionId, value }).then(
      () => true,
      (e: unknown) => {
        setError(errorMessage(e))
        return false
      },
    )
  }

  return (
    <div className="flex h-9 items-center gap-0.5 px-0.5 pt-0.5">
      {addMenu}
      {mode && <OptionMenu option={mode} onSelect={set} cycles />}
      {leftOthers.map((o) => (
        <OptionMenu key={o.id} option={o} onSelect={set} />
      ))}
      <span
        className={cn('min-w-0 flex-1 truncate text-xs text-danger', error && 'px-1.5')}
        title={error ?? undefined}
      >
        {error}
      </span>
      {rightOthers.map((o) => (
        <OptionMenu key={o.id} option={o} onSelect={set} />
      ))}
      {(model || effort || switches.length > 0) && (
        <ModelMenu
          heading={
            agent ? [agent.name, agent.account?.label].filter(Boolean).join(' · ') : undefined
          }
          source={agent?.version ? `${agent.harnessName} ${agent.version}` : null}
          model={model}
          effort={effort}
          switches={switches}
          ultracode={ultracodeOn ? 'on' : ultracode ? 'next' : null}
          running={running}
          onSelect={set}
          open={modelMenu.open}
          onOpenChange={modelMenu.onOpenChange}
          outOfCredit={outOfCredit}
        />
      )}
      {(timed || session.usage || warns) && (
        <span aria-hidden className="mx-1 h-3.5 w-px shrink-0 bg-border" />
      )}
      <CacheButton cache={timed} running={running} used={session.usage?.used ?? 0} />
      <ContextButton
        sessionId={session.id}
        agentId={session.agentId}
        idle={!running && session.status !== 'starting'}
        reports={agent?.capabilities.context ?? false}
        usage={session.usage}
        limits={agent?.limits ?? []}
        account={agent?.account ?? null}
        onCompact={onCompact}
      />
    </div>
  )
}

const MODE_ICON = {
  asks: ShieldIcon,
  edits: PencilIcon,
  plan: EyeIcon,
  auto: ShieldCheckIcon,
  full: TriangleAlertIcon,
} as const

/**
 * A menu for one option, which closes once a choice is made. The permission mode shows its icon,
 * each mode says what it does, and Full access alone is red; `cycles` notes that Shift+Tab steps
 * through the modes.
 */
export function OptionMenu({
  option,
  onSelect,
  side = 'top',
  align = 'start',
  cycles = false,
  className,
}: {
  option: SelectOption
  onSelect: Select
  side?: 'top' | 'bottom'
  align?: 'start' | 'end'
  cycles?: boolean
  /** The trigger's own styles, where a row sets its buttons otherwise. */
  className?: string
}) {
  const { t } = useTranslation('composer')
  const [value, pick] = usePick(option, onSelect)
  const isMode = option.category === 'mode'
  const look = modeLook(value)
  const Icon = MODE_ICON[look]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="quiet"
            size="sm"
            aria-label={t('controls.optionValue', {
              name: option.name,
              value: choiceName(option, value),
            })}
            className={cn(ROW_BUTTON, isMode && look === 'full' && 'text-danger', className)}
          />
        }
      >
        {isMode && <Icon strokeWidth={1.4} />}
        {choiceName(option, value)}
        {!isMode && <ChevronDownIcon strokeWidth={1.75} className="size-3 text-icon" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={side}
        align={align}
        sideOffset={6}
        aria-label={option.name}
        className={isMode ? 'w-85' : 'w-64'}
      >
        <DropdownMenuGroup>
          {/* Each mode says what it does, so the menu needs no heading. */}
          {!isMode && <DropdownMenuLabel>{option.name}</DropdownMenuLabel>}
          <DropdownMenuRadioGroup value={value} onValueChange={(v) => pick(String(v))}>
            {option.choices.map((choice) => {
              const ChoiceIcon = MODE_ICON[modeLook(choice.value)]
              return (
                <CheckRow key={choice.value} value={choice.value} described={!!choice.description}>
                  {isMode && <ChoiceIcon strokeWidth={1.4} />}
                  <ItemText
                    name={<ChoiceName name={choice.name} className="font-normal" />}
                    description={choice.description}
                    danger={isMode && modeLook(choice.value) === 'full'}
                  />
                </CheckRow>
              )
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        {cycles && option.choices.length > 1 && (
          <>
            <DropdownMenuSeparator />
            <div className="flex items-center gap-1.5 px-2 pt-1 pb-1.25 text-small text-tertiary">
              <Kbd>{formatShortcut('Shift')}</Kbd>
              <Kbd>{formatShortcut('Tab')}</Kbd>
              <span>{t('controls.cyclesModes')}</span>
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A choice whose check sits in a column before it, as every choice in the composer's menus. */
function CheckRow({
  value,
  described = false,
  className,
  children,
}: {
  value: string
  described?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <DropdownMenuRadioItem
      value={value}
      closeOnClick
      className={cn(
        'gap-2 pr-2 *:data-[slot=dropdown-menu-radio-item-indicator]:hidden',
        described && DESCRIBED_ROW,
        className,
      )}
    >
      <CheckColumn>
        <MenuPrimitive.RadioItemIndicator className="flex">
          <CheckIcon strokeWidth={1.75} className="size-3.5" />
        </MenuPrimitive.RadioItemIndicator>
      </CheckColumn>
      {children}
    </DropdownMenuRadioItem>
  )
}

export function ChoiceName({ name, className }: { name: string; className?: string }) {
  const [prefix, rest] = splitName(name)
  return (
    <span className={cn('block min-w-0 truncate font-medium', className)}>
      {prefix && <span className="text-muted-foreground">{prefix}</span>}
      {rest}
    </span>
  )
}

/** A boolean option as a row that keeps the menu open. */
function SwitchRow({
  option,
  icon,
  description,
  running,
  onSelect,
}: {
  option: ConfigOption
  icon?: ReactNode
  /** What it does, in place of the agent's own words. */
  description?: string
  running: boolean
  onSelect: Select
}) {
  const { t } = useTranslation('composer')
  const said =
    option.idleOnly && running ? t('controls.changesBetweenTurns') : (description ?? undefined)
  return (
    <DropdownMenuItem
      closeOnClick={false}
      role="menuitemcheckbox"
      aria-checked={option.value === true}
      disabled={option.idleOnly && running}
      onClick={() => void onSelect(option.id, option.value !== true)}
      className={cn('gap-2', said && DESCRIBED_ROW)}
    >
      {icon}
      <ItemText name={option.name} description={said} />
      <Switch
        size="sm"
        checked={option.value === true}
        tabIndex={-1}
        aria-hidden
        className="pointer-events-none ml-3"
      />
    </DropdownMenuItem>
  )
}

/** The Effort submenu: one row per level, in the agent's order, and ultracode last. */
function EffortMenu({
  effort,
  value,
  onPick,
  ultracode,
  running,
  onSelect,
}: {
  effort: SelectOption
  value: string | undefined
  onPick: (value: string) => void
  ultracode: ConfigOption | undefined
  running: boolean
  onSelect: Select
}) {
  const { t } = useTranslation('composer')
  const rows = levelRows(effort)
  const current = rows.find((row) => row.value === value)?.label ?? choiceName(effort, value)
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="gap-2">
        <GaugeIcon strokeWidth={1.4} />
        <span className="flex-1">{t('controls.effort')}</span>
        <span className="shrink-0 pl-4 text-hint text-tertiary">{current}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-65">
        <ScrollToChosen>
          <DropdownMenuRadioGroup value={value} onValueChange={(v) => onPick(String(v))}>
            {rows.map((row) => (
              <CheckRow key={row.value} value={row.value}>
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
              </CheckRow>
            ))}
          </DropdownMenuRadioGroup>
        </ScrollToChosen>
        <DropdownMenuSeparator />
        <p className="px-2 pt-1 pb-1.5 text-small text-tertiary">
          <Trans
            t={t}
            i18nKey="controls.levelsHint"
            values={{ shortcut: formatShortcut('Alt+E') }}
            components={{ shortcut: <span className="text-secondary" /> }}
          />
        </p>
        {ultracode && (
          <>
            <DropdownMenuSeparator />
            <SwitchRow
              option={ultracode}
              description={t('controls.ultracodeHint')}
              running={running}
              onSelect={onSelect}
            />
          </>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/** More models: the older and preview models, filtered as the user types. */
function MoreModelsMenu({
  choices,
  value,
  source,
  onPick,
  onClose,
}: {
  choices: NonNullable<ConfigOption['choices']>
  value: string | undefined
  /** The harness and version the list comes from. */
  source: string | null
  onPick: (value: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation('composer')
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="gap-2">
        <SparkleIcon strokeWidth={1.4} />
        <span className="flex-1">{t('controls.moreModels')}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-66">
        <SearchModels choices={choices} value={value} onPick={onPick} onClose={onClose} />
        {source && (
          <>
            <DropdownMenuSeparator />
            <p className="px-2 pt-1 pb-1.5 text-small text-tertiary">
              {t('controls.modelsFrom', { source })}
            </p>
          </>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/** The list of models, scrolled within 288 px and opened at the chosen one. */
function ScrollToChosen({ children }: { children: ReactNode }) {
  // Only on opening, so the list never jumps under the pointer.
  const showChosen = useCallback((list: HTMLDivElement | null) => {
    const chosen = list?.querySelector<HTMLElement>('[aria-checked=true], [data-selected]')
    if (list && chosen) {
      list.scrollTop = chosen.offsetTop - (list.clientHeight - chosen.offsetHeight) / 2
    }
  }, [])
  return (
    <div
      ref={showChosen}
      className="relative -mx-1 max-h-72 scroll-fade-y overflow-y-auto overscroll-contain px-1"
    >
      {children}
    </div>
  )
}

/** The part of a name that matches what was typed, in the fox tint. */
function Matched({ name, query }: { name: string; query: string }) {
  const at = query ? name.toLowerCase().indexOf(query.toLowerCase()) : -1
  if (at < 0) return <ChoiceName name={name} className="flex-1 font-normal" />
  return (
    <span className="block min-w-0 flex-1 truncate">
      {name.slice(0, at)}
      <mark className="rounded-xs bg-match text-primary">{name.slice(at, at + query.length)}</mark>
      {name.slice(at + query.length)}
    </span>
  )
}

/** More models as a search field over the list; picking one moves it into the main menu. */
function SearchModels({
  choices,
  value,
  onPick,
  onClose,
}: {
  choices: NonNullable<ConfigOption['choices']>
  value: string | undefined
  onPick: (value: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation('composer')
  const { contains } = useComboboxFilter()
  const [query, setQuery] = useState('')
  const byValue = new Map(choices.map((choice) => [choice.value, choice]))
  const label = (key: string) => byValue.get(key)?.name ?? key
  const showChosen = useCallback((list: HTMLDivElement | null) => {
    const chosen = list?.querySelector<HTMLElement>('[data-selected]')
    if (list && chosen) {
      list.scrollTop = chosen.offsetTop - (list.clientHeight - chosen.offsetHeight) / 2
    }
  }, [])
  return (
    <Combobox
      items={choices.map((choice) => choice.value)}
      value={value ?? null}
      onValueChange={(next: string | null) => {
        if (!next) return
        onPick(next)
        onClose()
      }}
      filter={(key: string, search: string) => contains(label(key), search)}
      inputValue={query}
      onInputValueChange={setQuery}
      itemToStringLabel={label}
      autoHighlight
    >
      <label className="mb-1 flex h-8 items-center gap-2 rounded-tile bg-subtle px-2.25 text-tertiary">
        <SearchIcon strokeWidth={1.4} className="size-3.5 shrink-0" />
        <ComboboxPrimitive.Input
          placeholder={t('controls.searchModels')}
          aria-label={t('controls.searchModels')}
          spellCheck={false}
          autoFocus
          className="min-w-0 flex-1 bg-transparent text-control text-primary outline-none placeholder:text-placeholder"
          // The search field owns its keys, and Esc closes the menu around it.
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Escape') {
              event.preventDefault()
              onClose()
            }
          }}
        />
      </label>
      <ComboboxList ref={showChosen} className="scroll-fade-y max-h-72 p-0">
        <ComboboxCollection>
          {(key: string) => {
            const choice = byValue.get(key)
            return (
              choice && (
                <Tooltip key={key}>
                  <TooltipTrigger
                    render={
                      <ComboboxItem
                        value={key}
                        onClick={onClose}
                        className="items-center pr-2 [&>.absolute]:hidden"
                      />
                    }
                  >
                    <CheckColumn>
                      {key === value && <CheckIcon strokeWidth={1.75} className="size-3.5" />}
                    </CheckColumn>
                    <Matched name={choice.name} query={query} />
                  </TooltipTrigger>
                  {choice.description && (
                    <TooltipContent side="right">{choice.description}</TooltipContent>
                  )}
                </Tooltip>
              )
            )
          }}
        </ComboboxCollection>
      </ComboboxList>
      {/* Sized by every model, so the menu keeps its width while the list filters. */}
      <div aria-hidden className="invisible h-0 overflow-hidden">
        {choices.map((choice) => (
          <div
            key={choice.value}
            className="flex items-center gap-2 px-2 text-ui whitespace-nowrap"
          >
            <span className="w-4" />
            <ChoiceName name={choice.name} className="flex-1" />
          </div>
        ))}
      </div>
    </Combobox>
  )
}

/**
 * One button for the model, with the reasoning level and ultracode after it, and one menu for
 * both. The current models are rows with what each is for, the older ones under More models and
 * the levels under Effort. Choosing a model, by click or with 1 to 4, or a level closes the menu;
 * the switches keep it open.
 */
function ModelMenu({
  heading,
  source,
  model,
  effort,
  switches,
  ultracode,
  running,
  onSelect,
  open,
  onOpenChange: setOpen,
  outOfCredit,
}: {
  /** The agent and its account, over the models. */
  heading: string | undefined
  source: string | null
  model: SelectOption | undefined
  effort: SelectOption | undefined
  switches: ConfigOption[]
  /** Ultracode is on for the session, or for the message being written. */
  ultracode: 'on' | 'next' | null
  running: boolean
  onSelect: Select
  open: boolean
  onOpenChange: (open: boolean) => void
  outOfCredit: boolean
}) {
  const { t } = useTranslation('composer')
  const [modelValue, pickModel] = usePick(model, onSelect)
  const [effortValue, pickEffort] = usePick(effort, onSelect)
  const choices = model?.choices ?? []
  const main = mainModels(choices, modelValue)
  const rest = splitModels(choices).older
  const checked = shownValue(choices, modelValue)
  const ultracodeOption = switches.find((o) => o.id === ULTRACODE_OPTION_ID)
  const otherSwitches = switches.filter((o) => o.id !== ULTRACODE_OPTION_ID)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    // Inside a submenu the keys belong to its rows or its search field.
    if ((event.target as Element).closest('[data-slot=dropdown-menu-sub-content]')) return
    const choice = numberedModel(main, event.key)
    if (!choice) return
    event.preventDefault()
    pickModel(choice.value)
    setOpen(false)
  }

  const label = model ? choiceName(model, modelValue) : undefined
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip disabled={!ultracode}>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  variant="quiet"
                  size="sm"
                  aria-label={outOfCredit ? t('controls.modelOutOfCredit') : t('controls.model')}
                  title={
                    label && !ultracode
                      ? outOfCredit
                        ? t('outOfCredit.modelTitle', { model: label })
                        : label
                      : undefined
                  }
                  className={cn(ROW_BUTTON, 'min-w-0 shrink gap-1.25')}
                />
              }
            />
          }
        >
          {outOfCredit && (
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
          )}
          {label && (
            <span className="truncate text-secondary group-aria-expanded/button:text-primary">
              {splitName(label)[1]}
            </span>
          )}
          {effort && !(model && levelsOf(effort, effortValue).usesDefault) && (
            <span className="shrink-0">{choiceName(effort, effortValue)}</span>
          )}
          {ultracode && <span className="shrink-0">{t('controls.ultracodeSuffix')}</span>}
          {!model && !effort && <span>{t('controls.options')}</span>}
          <ChevronDownIcon strokeWidth={1.75} className="size-3 text-icon" />
        </TooltipTrigger>
        <TooltipContent>
          {ultracode === 'on' ? t('controls.ultracodeOn') : t('controls.ultracodeNext')}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="top"
        align="end"
        sideOffset={6}
        onKeyDown={onKeyDown}
        className="w-72.5"
      >
        <DropdownMenuList>
          {model && (
            <DropdownMenuGroup>
              {heading && <DropdownMenuLabel>{heading}</DropdownMenuLabel>}
              <DropdownMenuRadioGroup value={checked} onValueChange={(v) => pickModel(String(v))}>
                {main.map((choice) => (
                  <CheckRow
                    key={choice.value}
                    value={choice.value}
                    described={!!choice.description}
                  >
                    <ItemText
                      name={<ChoiceName name={choice.name} className="font-normal" />}
                      description={choice.description}
                    />
                  </CheckRow>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          )}
          {(effort || rest.length > 0) && model && <DropdownMenuSeparator />}
          {effort && (
            <EffortMenu
              effort={effort}
              value={effortValue}
              onPick={pickEffort}
              ultracode={ultracodeOption}
              running={running}
              onSelect={onSelect}
            />
          )}
          {rest.length > 0 && (
            <MoreModelsMenu
              choices={rest}
              value={checked}
              source={source}
              onPick={pickModel}
              onClose={() => setOpen(false)}
            />
          )}
          {otherSwitches.length > 0 && (
            <>
              {(model || effort) && <DropdownMenuSeparator />}
              {otherSwitches.map((o) => (
                <SwitchRow
                  key={o.id}
                  option={o}
                  icon={/fast/i.test(o.id) ? <ZapIcon strokeWidth={1.4} /> : undefined}
                  running={running}
                  onSelect={onSelect}
                />
              ))}
            </>
          )}
        </DropdownMenuList>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A group label with the menus' look, for a menu that is not a Base UI menu. */
export function PlainLabel({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex h-7 items-center px-2 text-xs font-medium text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

/**
 * The reasoning levels as segments. The top levels carry their gradient, and landing on the
 * highest sweeps a light across its thumb once. A level set by hand can be reset to the agent's
 * default when the agent offers one. `plain` drops the menu parts, for a menu built otherwise.
 */
export function EffortSegments({
  effort,
  value,
  onPick,
  plain = false,
}: {
  effort: SelectOption
  value: string | undefined
  onPick: (value: string) => void
  plain?: boolean
}) {
  const { t } = useTranslation('composer')
  const labelId = useId()
  const { levels, fallback, usesDefault, shown } = levelsOf(effort, value)
  const tier = tierOf(effort, shown)
  const [seen, setSeen] = useState(shown)
  const [sweeps, setSweeps] = useState(0)
  if (seen !== shown) {
    setSeen(shown)
    if (tier === 'max') setSweeps((n) => n + 1)
  }

  const Group = plain ? 'div' : DropdownMenuGroup
  const Label = plain ? PlainLabel : DropdownMenuLabel
  return (
    <Group>
      <div className="flex items-center gap-1 pr-1">
        <Label id={labelId} className="flex-1">
          {effort.name}
        </Label>
        {usesDefault && fallback ? (
          <span className="px-1 text-xs text-muted-foreground">{fallback.name}</span>
        ) : (
          fallback && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="quiet"
                    size="icon-xs"
                    aria-label={t('controls.useFallback', { name: fallback.name.toLowerCase() })}
                    onClick={() => onPick(fallback.value)}
                  />
                }
              >
                <RotateCcwIcon />
              </TooltipTrigger>
              <TooltipContent>{t('controls.useDefault')}</TooltipContent>
            </Tooltip>
          )
        )}
      </div>
      <div className={plain ? 'px-2 pt-0.5 pb-1.5' : 'pb-1'}>
        <SegmentedControl
          aria-labelledby={labelId}
          value={shown ?? ''}
          segments={levels.map((c) => ({ value: c.value, label: c.name }))}
          onChange={onPick}
          thumb={
            tier === 'max' &&
            sweeps > 0 && (
              <span key={sweeps} className="absolute inset-0 motion-safe:animate-sheen" />
            )
          }
          className="w-full"
          itemClassName="px-1.5"
        />
      </div>
    </Group>
  )
}
