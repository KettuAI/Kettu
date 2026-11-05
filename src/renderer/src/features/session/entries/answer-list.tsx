import {
  Fragment,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react'
import { CheckIcon } from 'lucide-react'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import { Kbd } from '@renderer/components/ui/kbd'
import { Spinner } from '@renderer/components/ui/spinner'
import { isMac } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { useSessionsStore } from '@renderer/stores/sessions'
import { tileClass } from './card-style'
import { codeSpans } from './helpers'

/** The most answers a key picks: 1 to 9. */
export const NUMBERED = 9

export interface Answer {
  key: string
  label: ReactNode
  /** What the answer does, under it, as a question's choice explains itself. */
  description?: string
}

/** The number at a tile's end, in the fox once the tile is chosen. */
export function TileKey({ n, on }: { n: number; on: boolean }) {
  if (n > NUMBERED) return null
  return (
    <Kbd
      aria-hidden
      className={cn(
        'h-5 min-w-5 shrink-0 rounded-md bg-transparent text-key font-semibold tabular',
        on ? 'text-attention shadow-tile-key-on' : 'text-tertiary',
      )}
    >
      {n}
    </Kbd>
  )
}

/** A tile's radio, filled with the fox and its white dot when chosen. */
export function RadioMark({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-4.5 shrink-0 items-center justify-center rounded-full transition-colors duration-(--duration-fast)',
        on ? 'bg-control-on' : 'shadow-mark',
      )}
    >
      {on && <span className="size-1.5 rounded-full bg-(--on-fill)" />}
    </span>
  )
}

/** A tile's check box, filled with the fox and its white check when chosen. */
export function CheckMark({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-4.5 shrink-0 items-center justify-center rounded-lg text-(--on-fill) transition-colors duration-(--duration-fast)',
        on ? 'bg-control-on' : 'shadow-mark',
      )}
    >
      {on && <CheckIcon strokeWidth={2.8} className="size-3" />}
    </span>
  )
}

/**
 * A request's answers as tiles, one per row in the agent's order, each with its number. Choosing
 * one answers at once. The usual answer starts highlighted, with Return beside its number; the
 * arrow keys move the focus, and the number keys and Return answer through the rows'
 * `data-answer-option` (see the session view).
 */
export function AnswerList({
  ref,
  answers,
  primary,
  answering,
  disabled,
  label,
  onAnswer,
}: {
  ref?: Ref<HTMLDivElement>
  answers: Answer[]
  primary: number
  /** The answer on its way, which shows a spinner in place of its number. */
  answering: string | null
  disabled: boolean
  label: string
  onAnswer: (index: number) => void
}) {
  const [highlight, setHighlight] = useState(primary)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    const last = buttons.length - 1
    const next =
      event.key === 'ArrowDown' || event.key === 'ArrowRight'
        ? at === last
          ? 0
          : at + 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
          ? at === 0
            ? last
            : at - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null
    if (next === null) return
    event.preventDefault()
    buttons[next]?.focus()
  }

  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      className="flex flex-col gap-1.5 px-5 pt-3.5 pb-5"
      onKeyDown={onKeyDown}
    >
      {answers.map((answer, i) => {
        const highlighted = i === highlight
        return (
          <button
            key={answer.key}
            type="button"
            disabled={disabled || answering !== null}
            data-answer-option={i < NUMBERED ? i + 1 : undefined}
            data-highlighted={highlighted ? '' : undefined}
            aria-keyshortcuts={i < NUMBERED ? String(i + 1) : undefined}
            onFocus={() => setHighlight(i)}
            onClick={() => onAnswer(i)}
            className={cn(tileClass(highlighted), 'min-h-11 py-2 pr-2.5 pl-3.5')}
          >
            <span className="flex min-w-0 flex-1 flex-col gap-px">
              <span className="min-w-0 text-row font-medium wrap-anywhere">{answer.label}</span>
              {answer.description && (
                <span className="min-w-0 text-hint text-tertiary wrap-anywhere">
                  {answer.description}
                </span>
              )}
            </span>
            {answering === answer.key ? (
              <span className="flex size-5 shrink-0 items-center justify-center">
                <Spinner className="size-3.5" />
              </span>
            ) : (
              <span className="flex shrink-0 items-center gap-1">
                {highlighted && !disabled && (
                  <Kbd
                    aria-hidden
                    className="h-5 min-w-5 rounded-md bg-transparent text-key font-semibold text-attention shadow-tile-key-on"
                  >
                    ↩
                  </Kbd>
                )}
                <TileKey n={i + 1} on={highlighted} />
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/** An option's name, its `code` spans set in the code face, as an agent names a command. */
export function OptionName({ name }: { name: string }) {
  return codeSpans(name).map((part, i) =>
    part.code ? (
      <code
        key={i}
        className="rounded-sm bg-code-inline px-1.25 py-px font-mono text-command text-code-inline"
        translate="no"
      >
        {part.text}
      </code>
    ) : (
      <Fragment key={i}>{part.text}</Fragment>
    ),
  )
}

/** The status at a waiting card's right: a fox pill with the attention dot and what it waits for. */
export function WaitingStatus({ children }: { children: ReactNode }) {
  return (
    <span className="ml-auto inline-flex h-5.5 shrink-0 items-center gap-1.5 rounded-full bg-attention-dot/12 pr-2.25 pl-2 text-small leading-none font-medium text-attention">
      <span aria-hidden className="size-1.5 rounded-full bg-attention-dot" />
      {children}
    </span>
  )
}

/** A waiting card's frame: a faint fox ring that pulses once as the card arrives. */
export function WaitingCard({
  ref,
  label,
  description,
  entryId,
  className,
  children,
  onKeyDownCapture,
}: {
  ref?: Ref<HTMLDivElement>
  label: string
  /** What the agent asks, in a sentence, for a screen reader. */
  description?: string
  entryId: string
  className?: string
  children: ReactNode
  onKeyDownCapture?: (event: KeyboardEvent<HTMLDivElement>) => void
}) {
  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      aria-description={description}
      data-entry-id={entryId}
      onKeyDownCapture={onKeyDownCapture}
      className={cn(
        'flex animate-attention flex-col rounded-dialog bg-card text-card-foreground shadow-attention',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** A waiting card's header: who asks or what is asked, then the status pill at the right. */
export function WaitingHeader({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-10 min-w-0 shrink-0 items-center gap-2 pt-3 pr-4 pl-5 text-secondary">
      {children}
    </div>
  )
}

/** The shortcut that confirms a card, as its primary button shows it. */
export function ConfirmKeys() {
  return (
    <span aria-hidden className="inline-flex gap-0.5">
      {(isMac ? ['⌘', '↩'] : ['Ctrl', '↩']).map((key) => (
        <span
          key={key}
          className="inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-lg bg-primary-foreground/16 px-1 text-key leading-none font-medium text-primary-foreground/80"
        >
          {key}
        </span>
      ))}
    </span>
  )
}

/** A card's primary button, with its confirm keys. */
export function ConfirmButton({
  busy,
  children,
  ...props
}: ComponentProps<typeof Button> & { busy?: boolean }) {
  return (
    <Button
      size="sm"
      data-card-action=""
      data-answer-enter=""
      aria-keyshortcuts={isMac ? 'Meta+Enter' : 'Control+Enter'}
      className="gap-2 pr-1.5"
      {...props}
    >
      {busy && <Spinner className="size-3.5" />}
      {children}
      <ConfirmKeys />
    </Button>
  )
}

/** A card's footer: a note on what confirming does at the left, the buttons at the right. */
export function CardFooter({ note, children }: { note?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-1 pt-4 pr-4 pb-4 pl-5">
      {note && <span className="min-w-0 flex-1 text-hint text-tertiary">{note}</span>}
      <span className="ml-auto flex shrink-0 items-center gap-1">{children}</span>
    </div>
  )
}

/** A card's error, under its answers. */
export function CardError({ error }: { error: string | null }) {
  if (!error) return null
  return <p className="mx-5 mb-3 text-xs text-danger">{error}</p>
}

/** The "Skip" style quiet button of a card's footer. */
export function FooterButton(props: ComponentProps<typeof Button>) {
  return <Button variant="ghost" size="sm" data-card-action="" {...props} />
}

/** Who asks, at a waiting card's left: the agent's mark and name, then what it asks about. */
export function AgentWho({
  sessionId,
  name,
  sub,
}: {
  sessionId: string
  name: string
  sub?: string | null
}) {
  const agentId = useSessionsStore((s) => s.byId[sessionId]?.agentId ?? null)
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2 text-ui font-medium text-secondary">
      {agentId && <AgentMark agent={agentId} size={14} />}
      <span className="shrink-0">{name}</span>
      {sub && <span className="min-w-0 truncate font-normal text-tertiary">· {sub}</span>}
    </span>
  )
}
