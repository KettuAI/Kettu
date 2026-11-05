import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUpIcon, ChevronDownIcon, ChevronUpIcon, PencilIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Attachment, QueuedPrompt, SessionView } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { errorMessage, host } from '@renderer/lib/host'
import { useAgentsStore } from '@renderer/stores/agents'
import { restoreAttachments } from './composer/attachments'

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
 * The prompts waiting for the running turn. Folded, a card tucked behind the composer shows the
 * first with how many wait, the edges of the rest above it; opened, a panel on the composer's top
 * edge lists them all, each offering Send now while a turn runs, Edit in the composer and Remove
 * on hover or focus. A paused queue says so and offers to go on.
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
  const [open, setOpen] = useState(false)

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

  const first = queue[0]
  if (!first) return null

  const run = (request: Promise<unknown>) => {
    onError(null)
    request.catch((e: unknown) => onError(errorMessage(e)))
  }
  const sendNow = (item: QueuedPrompt) =>
    run(host('sessions.sendNow', { sessionId, itemId: item.id }))
  const edit = (item: QueuedPrompt) =>
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
  const remove = (item: QueuedPrompt) =>
    run(
      host('sessions.unqueue', { sessionId, itemId: item.id }).then(() =>
        Promise.all(
          queuedAttachments(item).map((attachment) =>
            host('attachments.remove', { id: attachment.id }),
          ),
        ),
      ),
    )
  const resume = () => run(host('sessions.resumeQueue', { sessionId }))

  if (!open) {
    const text = promptText(first)
    const attachments = queuedAttachments(first).length
    return (
      <div
        ref={region}
        className="relative mx-3.5 mt-2.5 -mb-3.5 animate-in fade-in animation-duration-(--duration-base) motion-reduce:animate-none"
      >
        {count > 1 && (
          <span
            aria-hidden
            className="absolute inset-x-3 -top-1.75 h-4 rounded-t-card bg-(--queue-back) shadow-[inset_0_0_0_1px_var(--border-subtle)]"
          />
        )}
        <button
          type="button"
          aria-expanded={false}
          aria-label={t('queue.label', { count })}
          onClick={() => setOpen(true)}
          className="relative flex h-11.5 w-full cursor-default items-start gap-2 rounded-t-card bg-surface pt-2.5 pr-3 pl-3.5 text-left text-ui text-secondary shadow-card outline-none hover:text-foreground focus-ring"
        >
          <span className="min-w-0 flex-1 truncate">
            {text || (attachments === 0 && t('queue.attachment'))}
            {attachments > 0 && (
              <span className="text-tertiary">
                {text && ' · '}
                {t('queue.attachments', { count: attachments })}
              </span>
            )}
          </span>
          {queuePaused && (
            <span className="shrink-0 text-small text-tertiary">{t('queue.paused')}</span>
          )}
          <span className="flex shrink-0 items-center gap-1 text-small font-medium text-tertiary">
            {t('queue.count', { count })}
            <ChevronUpIcon aria-hidden className="size-3.25" />
          </span>
        </button>
      </div>
    )
  }

  return (
    <div
      ref={region}
      role="region"
      aria-label={t('queue.label', { count })}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
      }}
      className="relative mx-2.5 mt-2 -mb-3.5 flex animate-in flex-col rounded-t-dialog bg-surface px-1.5 pt-1.5 pb-5 shadow-card fade-in animation-duration-(--duration-base) motion-reduce:animate-none"
    >
      <div className="flex h-8.5 items-center gap-2 pr-1 pl-2.5">
        <span className="text-small font-semibold text-secondary">{t('queue.title')}</span>
        {queuePaused && (
          <span className="flex items-center gap-1.5 text-small text-tertiary">
            <span aria-hidden className="size-1.5 rounded-full bg-(--text-tertiary)" />
            {t('queue.paused')}
          </span>
        )}
        <span className="flex-1" />
        {queuePaused && (
          <Button variant="outline" size="xs" onClick={resume}>
            {t('queue.resume')}
          </Button>
        )}
        <CardButton label={t('queue.collapse')} onClick={() => setOpen(false)}>
          <ChevronDownIcon />
        </CardButton>
      </div>
      <ol className="flex flex-col">
        {queue.map((item, i) => {
          const text = promptText(item)
          const attachments = queuedAttachments(item)
          return (
            <li
              key={item.id}
              className="group/queued flex min-h-10 items-center gap-2.5 rounded-xl py-1.5 pr-1.5 pl-2.5 text-row text-foreground hover:bg-hover focus-within:bg-hover"
            >
              <span
                aria-hidden
                className="flex size-4.5 shrink-0 items-center justify-center rounded-md text-count font-semibold text-tertiary shadow-tile tabular"
              >
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {text || (attachments.length === 0 && t('queue.attachment'))}
              </span>
              {item.device && (
                <span className="max-w-28 shrink-0 truncate text-small text-tertiary">
                  {t('queue.from', { device: item.device.name })}
                </span>
              )}
              {attachments.length > 0 && (
                <span className="flex max-w-40 shrink-0 items-center gap-1.25 rounded-lg bg-subtle px-1.75 py-0.5 text-small text-secondary">
                  {attachments.length === 1 ? (
                    <span className="truncate">{attachments[0]!.name}</span>
                  ) : (
                    t('queue.attachments', { count: attachments.length })
                  )}
                </span>
              )}
              <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-(--duration-fast) group-hover/queued:opacity-100 group-focus-within/queued:opacity-100">
                {running && (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button variant="outline" size="xs" onClick={() => sendNow(item)}>
                          <ArrowUpIcon />
                          {t('queue.sendNow')}
                        </Button>
                      }
                    />
                    <TooltipContent>
                      {t(steering ? 'queue.steer' : 'queue.stopAndSend')}
                    </TooltipContent>
                  </Tooltip>
                )}
                <CardButton label={t('queue.edit')} onClick={() => edit(item)}>
                  <PencilIcon />
                </CardButton>
                <CardButton label={t('queue.remove')} onClick={() => remove(item)}>
                  <XIcon strokeWidth={1.6} />
                </CardButton>
              </span>
            </li>
          )
        })}
      </ol>
    </div>
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
            className="size-6.5 shrink-0 text-tertiary [&_svg]:size-3.5 [&_svg]:stroke-[1.5]"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  )
}
