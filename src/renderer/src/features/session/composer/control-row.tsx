import {
  useCallback,
  useId,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { ChevronDownIcon, RotateCcwIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cacheExpiry } from '@shared/prompt-cache'
import { ULTRACODE_OPTION_ID, type ConfigOption, type SessionView } from '@shared/thread'
import { SegmentedControl } from '@renderer/components/segmented-control'
import { Button } from '@renderer/components/ui/button'
import {
  Combobox,
  ComboboxCollection,
  ComboboxInput,
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
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Switch } from '@renderer/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { errorMessage, host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { useAgentsStore } from '@renderer/stores/agents'
import { levelRows, levelsOf, splitName, tierOf, type SelectOption } from './levels'
import { mainModels, numberedModel, MAIN_MODELS } from './model-list'
import { UsageButton } from './usage'

/** Asks the agent to change an option; resolves to whether it did. */
type Select = (optionId: string, value: string | boolean) => Promise<boolean>

const isSelect = (o: ConfigOption): o is SelectOption => o.type === 'select' && !!o.choices?.length

function choiceName(option: SelectOption, value: string | undefined): string {
  return option.choices.find((c) => c.value === value)?.name ?? String(value)
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
  onCompact,
  ultracode = false,
  modelMenu,
  outOfCredit = false,
}: {
  session: SessionView
  onCompact: (() => void) | null
  /** The draft turns on Claude Code's ultracode for its message. */
  ultracode?: boolean
  /** The model menu's open state, so the out-of-credit strip can open it. */
  modelMenu: { open: boolean; onOpenChange: (open: boolean) => void }
  /** The model's provider refused the latest turn for want of credit. */
  outOfCredit?: boolean
}) {
  const { t } = useTranslation('composer')
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
    <div className="flex h-9 items-center gap-0.5 px-1 pt-0.5">
      {mode && <OptionMenu option={mode} onSelect={set} />}
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
      {(ultracode || ultracodeOn) && (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="animate-in px-1.5 text-xs font-medium fade-in animation-duration-(--duration-fast)" />
            }
          >
            <span className="text-secondary">Ultracode</span>
          </TooltipTrigger>
          <TooltipContent>
            {ultracodeOn ? t('controls.ultracodeOn') : t('controls.ultracodeNext')}
          </TooltipContent>
        </Tooltip>
      )}
      {(model || effort || switches.length > 0) && (
        <ModelMenu
          model={model}
          effort={effort}
          switches={switches}
          running={running}
          onSelect={set}
          open={modelMenu.open}
          onOpenChange={modelMenu.onOpenChange}
          outOfCredit={outOfCredit}
        />
      )}
      <UsageButton
        sessionId={session.id}
        agentId={session.agentId}
        idle={!running && session.status !== 'starting'}
        reports={agent?.capabilities.context ?? false}
        running={running}
        usage={session.usage}
        cache={cacheExpiry(session, agent?.account ?? null)}
        limits={agent?.limits ?? []}
        account={agent?.account ?? null}
        onCompact={onCompact}
      />
    </div>
  )
}

/** A menu for one option, which closes once a choice is made. */
export function OptionMenu({
  option,
  onSelect,
  side = 'top',
  align = 'start',
  className,
}: {
  option: SelectOption
  onSelect: Select
  side?: 'top' | 'bottom'
  align?: 'start' | 'end'
  /** The trigger's own styles, where a row sets its buttons otherwise. */
  className?: string
}) {
  const [value, pick] = usePick(option, onSelect)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="quiet"
            size="sm"
            aria-label={option.name}
            className={cn('gap-1 px-2.25 text-ui', className)}
          />
        }
      >
        {choiceName(option, value)}
        <ChevronDownIcon data-icon="inline-end" className="size-3 text-icon" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={side}
        align={align}
        sideOffset={6}
        aria-label={option.name}
        className="w-64"
      >
        {option.category === 'mode' ? (
          // Each mode says what it does, so the menu needs no heading.
          <Choices option={option} value={value} onPick={pick} closeOnClick />
        ) : (
          <DropdownMenuGroup>
            <DropdownMenuLabel>{option.name}</DropdownMenuLabel>
            <Choices option={option} value={value} onPick={pick} closeOnClick />
          </DropdownMenuGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Choices({
  option,
  value,
  onPick,
  closeOnClick = false,
}: {
  option: SelectOption
  value: string | undefined
  onPick: (value: string) => void
  closeOnClick?: boolean
}) {
  return (
    <DropdownMenuRadioGroup value={value} onValueChange={(v) => onPick(String(v))}>
      {option.choices.map((choice) => (
        <DropdownMenuRadioItem
          key={choice.value}
          value={choice.value}
          closeOnClick={closeOnClick}
          className="has-data-[slot=choice-description]:min-h-11 has-data-[slot=choice-description]:py-1.25 *:data-[slot=dropdown-menu-radio-item-indicator]:h-full"
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <ChoiceName name={choice.name} className="font-normal" />
            {choice.description && (
              <span data-slot="choice-description" className="text-xs text-muted-foreground">
                {choice.description}
              </span>
            )}
          </span>
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
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

// Past this many models in More models, a search field filters them.
const SEARCH_MODELS_AFTER = 12

/** One model or level: its name on one line, its description in a tooltip beside the row. */
function ChoiceRow({
  value,
  description,
  shortcut,
  className,
  children,
}: {
  value: string
  description?: string
  shortcut?: string
  className?: string
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <DropdownMenuRadioItem
            value={value}
            closeOnClick
            className={cn(
              'items-center',
              shortcut && 'pr-14 [&>[data-slot=dropdown-menu-radio-item-indicator]]:right-8',
              className,
            )}
          />
        }
      >
        {children}
        {shortcut && (
          <DropdownMenuShortcut className="absolute right-2 pl-0">{shortcut}</DropdownMenuShortcut>
        )}
      </TooltipTrigger>
      {description && <TooltipContent side="right">{description}</TooltipContent>}
    </Tooltip>
  )
}

/** A boolean option as a row that keeps the menu open. */
function SwitchRow({
  option,
  running,
  onSelect,
}: {
  option: ConfigOption
  running: boolean
  onSelect: Select
}) {
  const { t } = useTranslation('composer')
  return (
    <DropdownMenuItem
      closeOnClick={false}
      role="menuitemcheckbox"
      aria-checked={option.value === true}
      disabled={option.idleOnly && running}
      onClick={() => void onSelect(option.id, option.value !== true)}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">{option.name}</span>
        {option.idleOnly && running ? (
          <span className="text-xs text-muted-foreground">{t('controls.changesBetweenTurns')}</span>
        ) : (
          option.description && (
            <span className="text-xs text-muted-foreground">{option.description}</span>
          )
        )}
      </span>
      <Switch
        size="sm"
        checked={option.value === true}
        tabIndex={-1}
        aria-hidden
        className="pointer-events-none"
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
      <DropdownMenuSubTrigger>
        <span className="flex-1">{effort.name}</span>
        <span className="shrink-0 text-muted-foreground">{current}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <p className="w-56 px-2 pt-1.5 pb-2 text-xs text-muted-foreground">
          {t('controls.levelsHint')}
        </p>
        <ScrollToChosen>
          <DropdownMenuRadioGroup value={value} onValueChange={(v) => onPick(String(v))}>
            {rows.map((row) => (
              <ChoiceRow
                key={row.value}
                value={row.value}
                description={row.description}
                className="items-center"
              >
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
              </ChoiceRow>
            ))}
          </DropdownMenuRadioGroup>
        </ScrollToChosen>
        {ultracode && (
          <>
            <DropdownMenuSeparator />
            <SwitchRow option={ultracode} running={running} onSelect={onSelect} />
          </>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/** More models as a submenu: rows with tooltips, or a search menu once the list is long. */
function MoreModelsMenu({
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
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="flex-1">{t('controls.moreModels')}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {choices.length > SEARCH_MODELS_AFTER ? (
          <SearchModels choices={choices} value={value} onPick={onPick} onClose={onClose} />
        ) : (
          <DropdownMenuRadioGroup value={value} onValueChange={(v) => onPick(String(v))}>
            <ScrollToChosen>
              {choices.map((choice) => (
                <ChoiceRow key={choice.value} value={choice.value} description={choice.description}>
                  <ChoiceName name={choice.name} className="flex-1" />
                </ChoiceRow>
              ))}
            </ScrollToChosen>
          </DropdownMenuRadioGroup>
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

/** More models as a search menu, for an agent with dozens of them. */
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
      <div className="*:data-[slot=input-group]:h-9 *:data-[slot=input-group]:rounded-none *:data-[slot=input-group]:border-0 *:data-[slot=input-group]:bg-transparent *:data-[slot=input-group]:px-1.5 *:data-[slot=input-group]:shadow-[inset_0_calc(var(--hairline)*-1)_0_var(--border-soft)] *:data-[slot=input-group]:has-[[data-slot=input-group-control]:focus-visible]:outline-none *:data-[slot=input-group]:**:data-[slot=input-group-control]:px-2 *:data-[slot=input-group]:**:data-[slot=input-group-control]:text-ui">
        <ComboboxInput
          showTrigger={false}
          placeholder={t('controls.searchModels')}
          aria-label={t('controls.searchModels')}
          spellCheck={false}
          autoFocus
          // The search field owns its keys, and Esc closes the menu around it.
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Escape') {
              event.preventDefault()
              onClose()
            }
          }}
        />
      </div>
      <ComboboxList ref={showChosen} className="scroll-fade-y max-h-72">
        <ComboboxCollection>
          {(key: string) => {
            const choice = byValue.get(key)
            return (
              choice && (
                <Tooltip key={key}>
                  <TooltipTrigger
                    render={<ComboboxItem value={key} onClick={onClose} className="items-center" />}
                  >
                    <ChoiceName name={choice.name} className="flex-1" />
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
      <div aria-hidden className="invisible h-0 overflow-hidden px-1.5">
        {choices.map((choice) => (
          <div
            key={choice.value}
            className="flex items-center gap-2 pr-8 pl-2 text-ui whitespace-nowrap"
          >
            <ChoiceName name={choice.name} className="flex-1" />
          </div>
        ))}
      </div>
    </Combobox>
  )
}

/**
 * One button for the model, with the reasoning level after it, and one menu for both. The first
 * four models are one-line rows, with the rest under More models and the levels under Effort.
 * Choosing a model, by click or with 1 to 4, or a level closes the menu; the switches keep it open.
 */
function ModelMenu({
  model,
  effort,
  switches,
  running,
  onSelect,
  open,
  onOpenChange: setOpen,
  outOfCredit,
}: {
  model: SelectOption | undefined
  effort: SelectOption | undefined
  switches: ConfigOption[]
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
  const rest = choices.slice(MAIN_MODELS)
  const ultracode = switches.find((o) => o.id === ULTRACODE_OPTION_ID)
  const otherSwitches = switches.filter((o) => o.id !== ULTRACODE_OPTION_ID)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    // Inside a submenu the keys belong to its rows or its search field.
    if ((event.target as Element).closest('[data-slot=dropdown-menu-sub-content]')) return
    const choice = numberedModel(choices, event.key)
    if (!choice) return
    event.preventDefault()
    pickModel(choice.value)
    setOpen(false)
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="quiet"
            size="sm"
            aria-label={outOfCredit ? t('controls.modelOutOfCredit') : t('controls.model')}
            title={
              model
                ? outOfCredit
                  ? t('outOfCredit.modelTitle', { model: choiceName(model, modelValue) })
                  : choiceName(model, modelValue)
                : undefined
            }
            className="min-w-0 shrink gap-1 px-2.25 text-ui"
          />
        }
      >
        {outOfCredit && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />}
        {model && (
          <span className="truncate text-secondary">
            {splitName(choiceName(model, modelValue))[1]}
          </span>
        )}
        {effort && !(model && levelsOf(effort, effortValue).usesDefault) && (
          <span className="shrink-0 text-tertiary">{choiceName(effort, effortValue)}</span>
        )}
        {!model && !effort && <span>{t('controls.options')}</span>}
        <ChevronDownIcon data-icon="inline-end" className="size-3 text-icon" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" sideOffset={6} onKeyDown={onKeyDown}>
        <DropdownMenuList>
          {model && (
            <DropdownMenuRadioGroup value={modelValue} onValueChange={(v) => pickModel(String(v))}>
              {main.map((choice, index) => (
                <ChoiceRow
                  key={choice.value}
                  value={choice.value}
                  description={choice.description}
                  shortcut={index < MAIN_MODELS ? String(index + 1) : undefined}
                >
                  <ChoiceName name={choice.name} className="flex-1" />
                </ChoiceRow>
              ))}
            </DropdownMenuRadioGroup>
          )}
          {(effort || rest.length > 0) && model && <DropdownMenuSeparator />}
          {effort && (
            <EffortMenu
              effort={effort}
              value={effortValue}
              onPick={pickEffort}
              ultracode={ultracode}
              running={running}
              onSelect={onSelect}
            />
          )}
          {rest.length > 0 && (
            <MoreModelsMenu
              choices={rest}
              value={modelValue}
              onPick={pickModel}
              onClose={() => setOpen(false)}
            />
          )}
          {otherSwitches.length > 0 && (
            <>
              {(model || effort) && <DropdownMenuSeparator />}
              {otherSwitches.map((o) => (
                <SwitchRow key={o.id} option={o} running={running} onSelect={onSelect} />
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
