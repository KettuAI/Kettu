import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Autocomplete } from '@base-ui/react/autocomplete'
import { ArrowUpIcon, SquareIcon } from 'lucide-react'
import type { SessionView, SlashCommand } from '@shared/thread'
import { onAppEvent } from '@renderer/app/events'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@renderer/components/ui/input-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { resetTime } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { isMod } from '@renderer/lib/platform'
import { useAgentsStore } from '@renderer/stores/agents'
import { useSettingsStore } from '@renderer/stores/settings'
import { ControlRow } from './control-row'
import { clearDraft, flushDraft, readDraft, writeDraft } from './drafts'

type BaseUIKeyboardEvent = KeyboardEvent<HTMLTextAreaElement> & {
  preventBaseUIHandler?: () => void
}

/** The prompt box and the session's controls under it. */
export function Composer({ session, agentName }: { session: SessionView; agentName: string }) {
  const sessionId = session.id
  const [text, setText] = useState(() => readDraft(sessionId))
  const [error, setError] = useState<string | null>(null)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const group = useRef<HTMLDivElement>(null)
  const sendKey = useSettingsStore((s) => s.settings.general.sendKey)
  const limits = useAgentsStore((s) => s.byId[session.agentId]?.limits)

  const status = session.status
  const starting = status === 'starting'
  const running = status === 'running' || status === 'awaiting_permission'
  const awaiting = status === 'awaiting_permission'
  const canSend = status === 'ready' && text.trim().length > 0
  const reached = limits?.find((l) => l.state === 'reached')
  // Claude Code turns on ultracode for a message that says the word; no config option sets it.
  const ultracode = session.agentId === 'claude-code' && /\bultracode\b/i.test(text)

  useEffect(() => () => flushDraft(sessionId), [sessionId])

  useEffect(
    () =>
      onAppEvent((event) => {
        if (event.kind === 'focus-composer') textarea.current?.focus()
        if (
          event.kind === 'insert-into-composer' &&
          (!event.sessionId || event.sessionId === sessionId)
        ) {
          setText((current) => {
            const next = current ? `${current.replace(/\s+$/, '')}\n\n${event.text}` : event.text
            writeDraft(sessionId, next)
            return next
          })
          requestAnimationFrame(() => {
            const el = textarea.current
            if (!el) return
            el.focus()
            el.setSelectionRange(el.value.length, el.value.length)
          })
        }
      }),
    [sessionId],
  )

  // Starting a session focuses the composer, as the reference does.
  useEffect(() => {
    if (status === 'ready' && document.activeElement === document.body) textarea.current?.focus()
  }, [status])

  const update = (next: string) => {
    setText(next)
    writeDraft(sessionId, next)
    if (!next.startsWith('/')) setSlashDismissed(false)
  }

  const send = () => {
    if (!canSend) return
    const prompt = text
    setText('')
    clearDraft(sessionId)
    setError(null)
    host('sessions.prompt', { sessionId, content: [{ type: 'text', text: prompt }] }).catch(
      (e: unknown) => {
        setError(errorMessage(e))
        setText((current) => (current ? current : prompt))
      },
    )
  }

  const cancel = () => {
    host('sessions.cancel', { sessionId }).catch((e: unknown) => setError(errorMessage(e)))
  }

  const commands = session.commands
  const slashQuery = text.startsWith('/') && !/\s/.test(text) ? text.slice(1).toLowerCase() : null
  const slashMatches =
    slashQuery === null ? [] : commands.filter((c) => c.name.toLowerCase().includes(slashQuery))
  const slashOpen = slashQuery !== null && slashMatches.length > 0 && !slashDismissed
  const hint = (() => {
    const match = /^\/(\S+)\s$/.exec(text)
    return match ? commands.find((c) => c.name === match[1])?.inputHint : undefined
  })()

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition: Enter confirms the candidate, it never sends.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (slashOpen && (event.key === 'Enter' || event.key === 'Tab' || event.key === 'Escape'))
      return
    // With no list open, Base UI's autocomplete clears its input on Escape, which here is the draft.
    if (event.key === 'Escape') (event as BaseUIKeyboardEvent).preventBaseUIHandler?.()
    if (event.key === 'Escape' && running) {
      event.preventDefault()
      cancel()
      return
    }
    if (event.key !== 'Enter') return
    const sends = sendKey === 'enter' ? !event.shiftKey && !isMod(event) : isMod(event)
    if (!sends) return
    event.preventDefault()
    send()
  }

  const placeholder = starting
    ? `Starting ${agentName}…`
    : awaiting
      ? 'Waiting for your approval'
      : reached?.resetsAt
        ? `${reached.label} limit reached · resets ${resetTime(reached.resetsAt)}`
        : `Ask ${agentName} to…`

  const compact = commands.some((c) => c.name === 'compact')
    ? () => {
        if (status !== 'ready') return
        host('sessions.prompt', { sessionId, content: [{ type: 'text', text: '/compact' }] }).catch(
          (e: unknown) => setError(errorMessage(e)),
        )
      }
    : null

  return (
    <div className="flex flex-col gap-1">
      <Autocomplete.Root
        items={commands}
        value={text}
        onValueChange={(value) => update(value)}
        open={slashOpen}
        onOpenChange={(open) => {
          if (!open) setSlashDismissed(true)
        }}
        filter={(command: SlashCommand, query: string) =>
          query.startsWith('/') && command.name.toLowerCase().includes(query.slice(1).toLowerCase())
        }
        itemToStringValue={(command: SlashCommand) => `/${command.name} `}
        autoHighlight
      >
        <InputGroup ref={group} variant="composer" data-disabled={starting || undefined}>
          <div className="relative min-w-0 flex-1 self-stretch">
            <Autocomplete.Input
              render={
                <InputGroupTextarea
                  ref={textarea}
                  rows={1}
                  aria-label={`Message ${agentName}`}
                  placeholder={placeholder}
                  disabled={starting}
                  onKeyDown={onKeyDown}
                  className="max-h-[min(40svh,24rem)] min-h-(--composer-min) py-[15px] pr-1 pl-4 text-prose leading-[22px] placeholder:text-muted-foreground md:text-prose"
                />
              }
            />
            {hint && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 overflow-hidden py-[15px] pr-1 pl-4 text-prose leading-[22px] whitespace-pre"
              >
                <span className="invisible">{text}</span>
                <span className="text-muted-foreground">{hint}</span>
              </div>
            )}
          </div>
          <InputGroupAddon align="inline-end" className="self-end pr-3 pb-3 pl-1">
            {running ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <InputGroupButton
                      key="stop"
                      size="round"
                      variant="default"
                      aria-label="Stop"
                      onClick={cancel}
                      className="animate-in zoom-in-75 fade-in animation-duration-(--duration-fast)"
                    />
                  }
                >
                  <SquareIcon className="size-3 fill-current" />
                </TooltipTrigger>
                <TooltipContent>
                  Stop <span className="opacity-60">Esc</span>
                </TooltipContent>
              </Tooltip>
            ) : (
              <InputGroupButton
                key="send"
                size="round"
                variant={canSend ? 'default' : 'secondary'}
                aria-label="Send"
                disabled={!canSend}
                onClick={send}
                className="animate-in zoom-in-75 fade-in animation-duration-(--duration-fast)"
              >
                <ArrowUpIcon strokeWidth={2.25} />
              </InputGroupButton>
            )}
          </InputGroupAddon>
        </InputGroup>
        <Autocomplete.Portal>
          <Autocomplete.Positioner
            anchor={group}
            side="top"
            align="start"
            sideOffset={6}
            className="isolate z-50 outline-none"
          >
            <Autocomplete.Popup className="max-h-[min(var(--available-height),320px)] w-[min(var(--anchor-width),420px)] origin-(--transform-origin) overflow-y-auto rounded-xl bg-popover p-1 text-popover-foreground shadow-menu animation-duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
              <Autocomplete.List>
                {(command: SlashCommand) => (
                  <Autocomplete.Item
                    key={command.name}
                    value={command}
                    className="flex min-h-row cursor-default items-baseline gap-2 rounded-md px-2 py-1 text-[13px] outline-none select-none data-highlighted:bg-accent"
                  >
                    <span className="shrink-0 font-mono text-xs">/{command.name}</span>
                    <span className="min-w-0 truncate text-muted-foreground">
                      {command.description}
                    </span>
                  </Autocomplete.Item>
                )}
              </Autocomplete.List>
            </Autocomplete.Popup>
          </Autocomplete.Positioner>
        </Autocomplete.Portal>
      </Autocomplete.Root>
      {/* Holds the row's height while the agent starts, so nothing jumps when the options arrive. */}
      <div className="flex min-h-row flex-col">
        {error && (
          <p className="animate-in px-2 pt-1 text-xs text-destructive fade-in" role="alert">
            {error}
          </p>
        )}
        {!starting && <ControlRow session={session} onCompact={compact} ultracode={ultracode} />}
      </div>
    </div>
  )
}
