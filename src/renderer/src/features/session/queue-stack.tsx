import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CornerDownRightIcon,
  PencilIcon,
  PlayIcon,
  XIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Attachment, QueuedPrompt, SessionView } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { errorMessage, host } from '@renderer/lib/host'
import { useAgentsStore } from '@renderer/stores/agents'
import { restoreAttachments } from './composer/attachments'
import { shownPlace } from './queue-place'

function promptText(item: QueuedPrompt): string {
  return item.content
    .map((c) => (c.type === 'text' ? c.text : c.ref.kind === 'link' ? c.ref.uri : ''))
    .join(' ')
    .trim()
}

function queuedAttachments(item: QueuedPrompt): Attachment[] {
  return item.content.flatMap((c) =>
    c.type === 'ref' && c.ref.kind === 'attachment' ? [c.ref.attachment] : [],
  )
}

/**
 * The prompts waiting for the running turn, as a card tucked behind the composer with the edges
 * of the ones after it above. The arrows, or the arrow keys, page through them; each offers Send
 * now while a turn runs, Edit in the composer and Remove, and a paused queue offers Resume.
 */
export function QueueStack({
  session,
  onError,
}: {
  session: SessionView
  /** The latest action's error, or null once another starts or the queue empties. */
  onError: (message: string | null) => void
}) {
  const { t } = useTranslation('session')
  const steering = useAgentsStore((s) => !!s.byId[session.agentId]?.capabilities.steering)
  const { queue, queuePaused, status } = session
  const running = status === 'running' || status === 'awaiting_permission'
  const sessionId = session.id
  const count = queue.length
  const region = useRef<HTMLDivElement>(null)

  // The card keeps the message it shows while others leave, or the place of one that left.
  const [shown, setShown] = useState<{ id: string | null; index: number }>({ id: null, index: 0 })
  const index = shownPlace(
    queue.map((item) => item.id),
    shown,
  )
  const item = queue[index]
  const go = (to: number) => {
    const next = Math.max(0, Math.min(count - 1, to))
    setShown({ id: queue[next]?.id ?? null, index: next })
  }

  // Leaving with focus inside, as when the last message goes, hands it to the composer.
  useLayoutEffect(
    () => () => {
      if (region.current?.contains(document.activeElement)) {
        emitAppEvent({ kind: 'focus-composer' })
      }
      onError(null)
    },
    [onError],
  )

  if (!item) return null

  const run = (request: Promise<unknown>) => {
    onError(null)
    request.catch((e: unknown) => onError(errorMessage(e)))
  }
  const sendNow = () => run(host('sessions.sendNow', { sessionId, itemId: item.id }))
  const edit = () =>
    run(
      host('sessions.unqueue', { sessionId, itemId: item.id }).then(() => {
        if (restoreAttachments(sessionId, item.content) > 0) {
          onError(t('attachments.limit', { ns: 'composer' }))
        }
        const text = promptText(item)
        emitAppEvent(
          text ? { kind: 'insert-into-composer', sessionId, text } : { kind: 'focus-composer' },
        )
      }),
    )
  const remove = () =>
    run(
      host('sessions.unqueue', { sessionId, itemId: item.id }).then(() =>
        Promise.all(
          queuedAttachments(item).map((attachment) =>
            host('attachments.remove', { id: attachment.id }),
          ),
        ),
      ),
    )

  const text = promptText(item)
  const attachments = queuedAttachments(item).length
  const behind = count - index - 1

  return (
    <div className="relative mx-3 mt-2 -mb-2.5 animate-in fade-in animation-duration-(--duration-base) motion-reduce:animate-none">
      {behind > 1 && (
        <span
          aria-hidden
          className="absolute inset-x-6 -top-2 h-3 rounded-t-[9px] bg-(--queue-back) shadow-[inset_0_0_0_1px_var(--border-subtle)]"
        />
      )}
      {behind > 0 && (
        <span
          aria-hidden
          className="absolute inset-x-3 -top-1 h-3 rounded-t-2xl bg-(--queue-back-near) shadow-[inset_0_0_0_1px_var(--border-subtle)]"
        />
      )}
      <div
        ref={region}
        role="region"
        aria-label={t('queue.label', { count })}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
          if (event.nativeEvent.isComposing) return
          event.preventDefault()
          go(index + (event.key === 'ArrowUp' ? -1 : 1))
        }}
        className="relative flex h-10.5 items-center gap-1.5 rounded-t-[12px] bg-surface pr-1.5 pb-2.5 pl-3 text-ui shadow-card"
      >
        <CornerDownRightIcon aria-hidden strokeWidth={1.5} className="size-3.25 shrink-0" />
        <span key={item.id} className="min-w-0 flex-1 truncate pl-0.5">
          {text || (attachments === 0 && t('queue.attachment'))}
          {attachments > 0 && (
            <span className="text-tertiary">
              {text && ' · '}
              {t('queue.attachments', { count: attachments })}
            </span>
          )}
        </span>
        {item.device && (
          <span className="max-w-28 shrink-0 truncate text-small text-tertiary">
            {t('queue.from', { device: item.device.name })}
          </span>
        )}
        {queuePaused && (
          <span className="shrink-0 text-small text-tertiary">{t('queue.paused')}</span>
        )}
        {count > 1 && (
          <>
            <span className="shrink-0 text-small text-tertiary tabular">
              {t('queue.position', { number: index + 1, count })}
            </span>
            <span className="mr-0.5 flex shrink-0 flex-col">
              <PageButton
                label={t('queue.previous')}
                disabled={index === 0}
                onClick={() => go(index - 1)}
              >
                <ChevronUpIcon />
              </PageButton>
              <PageButton
                label={t('queue.following')}
                disabled={index === count - 1}
                onClick={() => go(index + 1)}
              >
                <ChevronDownIcon />
              </PageButton>
            </span>
          </>
        )}
        <span aria-hidden className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />
        {queuePaused && (
          <CardButton
            label={t('queue.resume')}
            onClick={() => run(host('sessions.resumeQueue', { sessionId }))}
          >
            <PlayIcon />
          </CardButton>
        )}
        {running && (
          <CardButton
            label={t('queue.sendNow')}
            tip={t(steering ? 'queue.steer' : 'queue.stopAndSend')}
            onClick={sendNow}
          >
            <ArrowUpIcon />
          </CardButton>
        )}
        <CardButton label={t('queue.edit')} onClick={edit}>
          <PencilIcon />
        </CardButton>
        <CardButton label={t('queue.remove')} onClick={remove}>
          <XIcon strokeWidth={1.6} className="size-3!" />
        </CardButton>
      </div>
    </div>
  )
}

function PageButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    // aria-disabled keeps a focused arrow focused when it reaches the end.
    <button
      type="button"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onClick={() => !disabled && onClick()}
      className="grid h-2.75 w-4.5 place-items-center rounded-xs text-secondary outline-none focus-visible:focus-ring aria-disabled:text-border-strong [&_svg]:size-2.75 [&_svg]:stroke-[1.7]"
    >
      {children}
    </button>
  )
}

function CardButton({
  label,
  tip = label,
  onClick,
  children,
}: {
  label: string
  tip?: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="quiet"
            size="icon-xs"
            aria-label={label}
            onClick={onClick}
            className="size-5.5 shrink-0 text-tertiary [&_svg]:size-3.25 [&_svg]:stroke-[1.5]"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  )
}
