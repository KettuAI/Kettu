import { Fragment, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { Kbd } from '@renderer/components/ui/kbd'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'
import { codeSpans } from './helpers'

/** The most answers a key picks: 1 to 9. */
export const NUMBERED = 9

export interface Answer {
  key: string
  label: ReactNode
  /** What the answer means, under it, as a question's choice explains itself. */
  description?: string
}

/**
 * A card's answers, one per row in the agent's order, each with its number. The usual answer
 * starts highlighted; the pointer and the arrow keys move the highlight, and the number keys and
 * Enter answer through the rows' `data-answer-option` (see the session view).
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
      className="flex flex-col gap-px p-1.5"
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
            onPointerEnter={() => setHighlight(i)}
            onFocus={() => setHighlight(i)}
            onClick={() => onAnswer(i)}
            className="flex min-h-9 w-full min-w-0 cursor-default items-center gap-2.5 rounded-lg py-1.5 pr-2.5 pl-2 text-left text-row text-foreground outline-none transition-colors duration-(--duration-fast) focus-ring disabled:opacity-60 data-highlighted:bg-selected"
          >
            {answering === answer.key ? (
              <span className="flex size-5 shrink-0 items-center justify-center">
                <Spinner className="size-3.5" />
              </span>
            ) : i < NUMBERED ? (
              <Kbd
                aria-hidden
                variant={highlighted ? 'primary' : 'default'}
                className="h-5 min-w-5 rounded-md text-key font-semibold"
              >
                {i + 1}
              </Kbd>
            ) : (
              <span aria-hidden className="size-5 shrink-0" />
            )}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="min-w-0 truncate">{answer.label}</span>
              {answer.description && (
                <span className="min-w-0 truncate text-hint text-tertiary">
                  {answer.description}
                </span>
              )}
            </span>
            {highlighted && answering === null && !disabled && (
              <span aria-hidden className="shrink-0 text-control text-tertiary">
                ↵
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
        className="rounded-sm bg-code-inline px-1.25 py-px font-mono text-command"
        translate="no"
      >
        {part.text}
      </code>
    ) : (
      <Fragment key={i}>{part.text}</Fragment>
    ),
  )
}

/** The status at a waiting card's right: the attention dot and what it waits for. */
export function WaitingStatus({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.75 text-small font-medium text-attention">
      <span aria-hidden className="size-1.75 rounded-full bg-attention-dot" />
      {children}
    </span>
  )
}

/** A waiting card's frame: the fox ring with its halo, around a header and its answers. */
export function WaitingCard({
  ref,
  label,
  description,
  entryId,
  className,
  children,
}: {
  ref?: Ref<HTMLDivElement>
  label: string
  /** What the agent asks, in a sentence, for a screen reader. */
  description?: string
  entryId: string
  className?: string
  children: ReactNode
}) {
  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      aria-description={description}
      data-entry-id={entryId}
      className={cn(
        'flex animate-attention flex-col overflow-hidden rounded-xl bg-card text-card-foreground shadow-attention',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** A waiting card's 40 px header: icon, verb, what it acts on, and the status at the right. */
export function WaitingHeader({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-card-header min-w-0 shrink-0 items-center gap-2 border-b border-border-soft px-3.5 text-tertiary">
      {children}
    </div>
  )
}
