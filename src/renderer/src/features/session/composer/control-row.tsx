import { useCallback, useId, useState, type ComponentProps, type KeyboardEvent } from 'react'
import { ChevronDownIcon, RotateCcwIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ULTRACODE_OPTION_ID, type ConfigOption, type SessionView } from '@shared/thread'
import { SegmentedControl } from '@renderer/components/segmented-control'
import { Button } from '@renderer/components/ui/button'
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
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Switch } from '@renderer/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { errorMessage, host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { useAgentsStore } from '@renderer/stores/agents'
import { levelsOf, splitName, tierOf, tierText, type SelectOption } from './levels'
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
}: {
  session: SessionView
  onCompact: (() => void) | null
  /** The draft turns on Claude Code's ultracode for its message. */
  ultracode?: boolean
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
    <div className="flex h-row items-center gap-0.5 px-1">
      {mode && <OptionMenu option={mode} onSelect={set} />}
      {leftOthers.map((o) => (
        <OptionMenu key={o.id} option={o} onSelect={set} />
      ))}
      <span
        className="min-w-0 flex-1 truncate px-1.5 text-xs text-destructive"
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
            <span className="text-effort-max">Ultracode</span>
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
        />
      )}
      <UsageButton
        sessionId={session.id}
        agentId={session.agentId}
        idle={session.status === 'ready'}
        usage={session.usage}
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
}: {
  option: SelectOption
  onSelect: Select
  side?: 'top' | 'bottom'
}) {
  const [value, pick] = usePick(option, onSelect)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="quiet" size="compact" aria-label={option.name} className="gap-1 px-2" />
        }
      >
        {choiceName(option, value)}
        <ChevronDownIcon data-icon="inline-end" className="size-3 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side={side} sideOffset={6} className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{option.name}</DropdownMenuLabel>
          <Choices option={option} value={value} onPick={pick} closeOnClick />
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Choices({
  option,
  value,
  onPick,
  closeOnClick = false,
  numbered = false,
}: {
  option: SelectOption
  value: string | undefined
  onPick: (value: string) => void
  closeOnClick?: boolean
  numbered?: boolean
}) {
  return (
    <DropdownMenuRadioGroup value={value} onValueChange={(v) => onPick(String(v))}>
      {option.choices.map((choice, i) => (
        <DropdownMenuRadioItem
          key={choice.value}
          value={choice.value}
          closeOnClick={closeOnClick}
          className="items-start"
        >
          <span className="flex min-w-0 flex-1 flex-col">
            {/* The number shares the name's baseline, not the top of a two-line row. */}
            <span className="flex items-baseline gap-2">
              <ChoiceName name={choice.name} />
              {numbered && i < 4 && <DropdownMenuShortcut>{i + 1}</DropdownMenuShortcut>}
            </span>
            {choice.description && (
              <span className="text-xs text-muted-foreground">{choice.description}</span>
            )}
          </span>
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  )
}

export function ChoiceName({ name }: { name: string }) {
  const [prefix, rest] = splitName(name)
  return (
    <span className="font-medium break-words">
      {prefix && <span className="text-muted-foreground">{prefix}</span>}
      {rest}
    </span>
  )
}

// More levels than this do not fit as segments, so they are listed like models.
const MAX_SEGMENTS = 6

/**
 * One button for the model, with the reasoning level after it, and one menu for both. Choosing a
 * model, by click or with 1 to 4, closes the menu; the level, which the left and right arrows
 * step, and the switches keep it open, so several can be set in one visit.
 */
function ModelMenu({
  model,
  effort,
  switches,
  running,
  onSelect,
}: {
  model: SelectOption | undefined
  effort: SelectOption | undefined
  switches: ConfigOption[]
  running: boolean
  onSelect: Select
}) {
  const { t } = useTranslation('composer')
  const [open, setOpen] = useState(false)
  const [modelValue, pickModel] = usePick(model, onSelect)
  const [effortValue, pickEffort] = usePick(effort, onSelect)
  const level = effort ? levelsOf(effort, effortValue) : null
  const segmented = !!level && level.levels.length > 0 && level.levels.length <= MAX_SEGMENTS
  // The list opens scrolled to the chosen model; only on opening, so it never jumps under the pointer.
  const showChosen = useCallback((list: HTMLDivElement | null) => {
    const chosen = list?.querySelector<HTMLElement>('[aria-checked=true]')
    if (list && chosen) {
      list.scrollTop = chosen.offsetTop - (list.clientHeight - chosen.offsetHeight) / 2
    }
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const n = Number(event.key)
    const choice = Number.isInteger(n) && n >= 1 && n <= 4 ? model?.choices[n - 1] : undefined
    if (choice) {
      event.preventDefault()
      pickModel(choice.value)
      setOpen(false)
      return
    }
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    // Inside the segments the arrows move focus between them instead.
    const inSegments = (event.target as Element).closest('[data-slot=toggle-group]')
    if (!level || step === 0 || inSegments) return
    event.preventDefault()
    const { levels, shown } = level
    const index = levels.findIndex((c) => c.value === shown)
    const next =
      index < 0 ? levels[0] : levels[Math.min(levels.length - 1, Math.max(0, index + step))]
    if (next) pickEffort(next.value)
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="quiet"
            size="compact"
            aria-label={t('controls.model')}
            title={model ? choiceName(model, modelValue) : undefined}
            className="min-w-0 shrink gap-1 px-2"
          />
        }
      >
        {model && (
          <span className="truncate text-foreground">
            {splitName(choiceName(model, modelValue))[1]}
          </span>
        )}
        {effort && !(model && level?.usesDefault) && (
          <span className="shrink-0">{choiceName(effort, effortValue)}</span>
        )}
        {!model && !effort && <span>{t('controls.options')}</span>}
        <ChevronDownIcon data-icon="inline-end" className="size-3 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="end"
        sideOffset={6}
        className="w-80"
        onKeyDown={onKeyDown}
      >
        <DropdownMenuList>
          {model && (
            <DropdownMenuGroup>
              <DropdownMenuLabel>{model.name}</DropdownMenuLabel>
              {/* A long list scrolls by itself, so the levels below stay in view. */}
              <div
                ref={showChosen}
                className="relative -mx-1 max-h-72 scroll-fade-y overflow-y-auto overscroll-contain px-1"
              >
                <Choices
                  option={model}
                  value={modelValue}
                  onPick={pickModel}
                  numbered
                  closeOnClick
                />
              </div>
            </DropdownMenuGroup>
          )}
          {effort && (
            <>
              {model && <DropdownMenuSeparator />}
              {segmented ? (
                <EffortSegments effort={effort} value={effortValue} onPick={pickEffort} />
              ) : (
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{effort.name}</DropdownMenuLabel>
                  <Choices option={effort} value={effortValue} onPick={pickEffort} />
                </DropdownMenuGroup>
              )}
            </>
          )}
          {switches.length > 0 && (
            <>
              {(model || effort) && <DropdownMenuSeparator />}
              <DropdownMenuGroup>
                {switches.map((o) => (
                  <DropdownMenuItem
                    key={o.id}
                    closeOnClick={false}
                    role="menuitemcheckbox"
                    aria-checked={o.value === true}
                    disabled={o.idleOnly && running}
                    onClick={() => void onSelect(o.id, o.value !== true)}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="font-medium">{o.name}</span>
                      {o.idleOnly && running ? (
                        <span className="text-xs text-muted-foreground">
                          {t('controls.changesBetweenTurns')}
                        </span>
                      ) : (
                        o.description && (
                          <span className="text-xs text-muted-foreground">{o.description}</span>
                        )
                      )}
                    </span>
                    <Switch
                      size="sm"
                      checked={o.value === true}
                      tabIndex={-1}
                      aria-hidden
                      className="pointer-events-none"
                    />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
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
      className={cn('px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground', className)}
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
      <div className="pb-1">
        <SegmentedControl
          aria-labelledby={labelId}
          value={shown ?? ''}
          segments={levels.map((c) => {
            const levelTier = tierOf(effort, c.value)
            return {
              value: c.value,
              label: (active: boolean) =>
                active && levelTier ? (
                  <span className={tierText[levelTier]}>{c.name}</span>
                ) : (
                  c.name
                ),
            }
          })}
          onChange={onPick}
          thumbClassName={(v) => (tierOf(effort, v) === 'max' ? 'shadow-effort-max' : undefined)}
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
