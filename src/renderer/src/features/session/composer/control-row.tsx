import { useState, type KeyboardEvent } from 'react'
import { ChevronDownIcon } from 'lucide-react'
import type { ConfigOption, SessionView } from '@shared/thread'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
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
import { errorMessage, host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { useAgentsStore } from '@renderer/stores/agents'
import { UsageButton } from './usage'

type SelectOption = ConfigOption & { type: 'select'; choices: NonNullable<ConfigOption['choices']> }

const isSelect = (o: ConfigOption): o is SelectOption => o.type === 'select' && !!o.choices?.length

function choiceName(option: SelectOption): string {
  return option.choices.find((c) => c.value === option.value)?.name ?? String(option.value)
}

/** The session's controls under the composer, built from the agent's config options. */
export function ControlRow({
  session,
  onCompact,
}: {
  session: SessionView
  onCompact: (() => void) | null
}) {
  const agent = useAgentsStore((s) => s.byId[session.agentId])
  const [error, setError] = useState<string | null>(null)
  const config = session.config
  const mode = config.find((o) => o.category === 'mode' && isSelect(o)) as SelectOption | undefined
  const model = config.find((o) => o.category === 'model' && isSelect(o)) as
    SelectOption | undefined
  const effort = config.find((o) => o.category === 'thought_level' && isSelect(o)) as
    SelectOption | undefined
  const switches = config.filter((o) => o.type === 'boolean')
  const others = config.filter(
    (o): o is SelectOption => isSelect(o) && o !== mode && o !== model && o !== effort,
  )
  const leftOthers = others.filter((o) => o.category === 'other')
  const rightOthers = others.filter((o) => o.category !== 'other')

  const set = (optionId: string, value: string | boolean) => {
    setError(null)
    host('sessions.setConfigOption', { sessionId: session.id, optionId, value }).catch(
      (e: unknown) => setError(errorMessage(e)),
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
      {(model || effort || switches.length > 0) && (
        <ModelMenu model={model} effort={effort} switches={switches} onSelect={set} />
      )}
      <UsageButton
        usage={session.usage}
        limits={agent?.limits ?? []}
        account={agent?.account ?? null}
        onCompact={onCompact}
      />
    </div>
  )
}

function OptionMenu({
  option,
  onSelect,
}: {
  option: SelectOption
  onSelect: (optionId: string, value: string) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="quiet" size="compact" aria-label={option.name} className="gap-1 px-2" />
        }
      >
        {choiceName(option)}
        <ChevronDownIcon data-icon="inline-end" className="size-3 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" sideOffset={6} className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{option.name}</DropdownMenuLabel>
          <Choices option={option} onSelect={onSelect} />
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Choices({
  option,
  onSelect,
  numbered = false,
}: {
  option: SelectOption
  onSelect: (optionId: string, value: string) => void
  numbered?: boolean
}) {
  return (
    <DropdownMenuRadioGroup
      value={String(option.value)}
      onValueChange={(v) => onSelect(option.id, String(v))}
    >
      {option.choices.map((choice, i) => (
        <DropdownMenuRadioItem key={choice.value} value={choice.value} className="items-start">
          <span className="flex min-w-0 flex-col py-px">
            <span>{choice.name}</span>
            {choice.description && (
              <span className="text-xs text-muted-foreground">{choice.description}</span>
            )}
          </span>
          {numbered && i < 4 && (
            <DropdownMenuShortcut className="mr-5">{i + 1}</DropdownMenuShortcut>
          )}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  )
}

/** One button for the model, with the reasoning level in muted text, and a menu for all of it. */
function ModelMenu({
  model,
  effort,
  switches,
  onSelect,
}: {
  model: SelectOption | undefined
  effort: SelectOption | undefined
  switches: ConfigOption[]
  onSelect: (optionId: string, value: string | boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const pickByNumber = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!model || event.metaKey || event.ctrlKey || event.altKey) return
    const n = Number(event.key)
    const choice = Number.isInteger(n) && n >= 1 && n <= 4 ? model.choices[n - 1] : undefined
    if (!choice) return
    event.preventDefault()
    onSelect(model.id, choice.value)
    setOpen(false)
  }
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={<Button variant="quiet" size="compact" aria-label="Model" className="gap-1 px-2" />}
      >
        {model && <span className="text-foreground">{choiceName(model)}</span>}
        {effort && <span>{choiceName(effort)}</span>}
        {!model && !effort && <span>Options</span>}
        <ChevronDownIcon data-icon="inline-end" className="size-3 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="end"
        sideOffset={6}
        className="w-64"
        onKeyDown={pickByNumber}
      >
        {model && (
          <DropdownMenuGroup>
            <DropdownMenuLabel>{model.name}</DropdownMenuLabel>
            <Choices option={model} onSelect={onSelect} numbered />
          </DropdownMenuGroup>
        )}
        {effort && (
          <>
            {model && <DropdownMenuSeparator />}
            <DropdownMenuGroup>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <span className="flex-1">{effort.name}</span>
                  <span className="text-xs text-muted-foreground">{choiceName(effort)}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-56">
                  <Choices option={effort} onSelect={onSelect} />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuGroup>
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
                  onClick={() => onSelect(o.id, o.value !== true)}
                >
                  <span className="flex min-w-0 flex-1 flex-col py-px">
                    <span>{o.name}</span>
                    {o.description && (
                      <span className="text-xs text-muted-foreground">{o.description}</span>
                    )}
                  </span>
                  <Switch
                    size="sm"
                    checked={o.value === true}
                    tabIndex={-1}
                    aria-hidden
                    className={cn('pointer-events-none')}
                  />
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
