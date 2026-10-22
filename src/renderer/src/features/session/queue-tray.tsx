import { useState, type ReactNode } from 'react'
import { CornerDownRightIcon, PencilIcon, PlayIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { QueuedPrompt, SessionView } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { errorMessage, host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { useAgentsStore } from '@renderer/stores/agents'

function promptText(item: QueuedPrompt): string {
  return item.content
    .map((c) => (c.type === 'text' ? c.text : c.ref.kind === 'link' ? c.ref.uri : ''))
    .join(' ')
    .trim()
}

function TrayButton({
  label,
  onClick,
  children,
}: {
  label: string
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
            className="shrink-0 rounded-[6px] [&_svg]:size-3.5"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Prompts waiting for the running turn, pinned above the composer. Each can be steered into the
 * turn where the agent allows it, moved back into the composer to edit, or removed.
 */
export function QueueTray({ session }: { session: SessionView }) {
  const { t } = useTranslation('session')
  const steering = useAgentsStore((s) => !!s.byId[session.agentId]?.capabilities.steering)
  const [error, setError] = useState<string | null>(null)
  const { queue, queuePaused, status } = session
  const running = status === 'running' || status === 'awaiting_permission'
  const sessionId = session.id

  const run = (request: Promise<unknown>) => {
    setError(null)
    request.catch((e: unknown) => setError(errorMessage(e)))
  }
  const edit = (item: QueuedPrompt) => {
    run(
      host('sessions.unqueue', { sessionId, itemId: item.id }).then(() =>
        emitAppEvent({ kind: 'insert-into-composer', sessionId, text: promptText(item) }),
      ),
    )
  }

  return (
    <div
      className="mx-3 animate-in overflow-hidden rounded-t-xl bg-card/80 shadow-card fade-in animation-duration-(--duration-base)"
      aria-label={t('queue.label')}
      role="group"
    >
      <div className="flex h-row items-center gap-2 px-3 text-xs">
        <span className="font-medium tabular">{t('queue.queued', { total: queue.length })}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {queuePaused ? t('queue.paused') : running ? t('queue.waiting') : t('queue.sending')}
        </span>
        {error && (
          <span className="max-w-[40%] truncate text-destructive" title={error}>
            {error}
          </span>
        )}
        {queuePaused && (
          <Button
            variant="quiet"
            size="xs"
            onClick={() => run(host('sessions.resumeQueue', { sessionId }))}
          >
            <PlayIcon data-icon="inline-start" />
            {t('queue.resume')}
          </Button>
        )}
      </div>
      <ul className="max-h-[30svh] overflow-y-auto border-t border-border-soft py-0.5">
        {queue.map((item, i) => (
          <li
            key={item.id}
            className={cn(
              'group/queued flex h-row items-center gap-2 pr-1.5 pl-3 text-ui',
              i > 0 && 'text-muted-foreground',
            )}
          >
            <span className="min-w-0 flex-1 truncate">
              {promptText(item) || t('queue.attachment')}
            </span>
            <span className="flex shrink-0 items-center opacity-60 transition-opacity duration-(--duration-fast) group-hover/queued:opacity-100 group-focus-within/queued:opacity-100">
              {steering && running && (
                <TrayButton
                  label={t('queue.steer')}
                  onClick={() => run(host('sessions.steer', { sessionId, itemId: item.id }))}
                >
                  <CornerDownRightIcon />
                </TrayButton>
              )}
              <TrayButton label={t('queue.edit')} onClick={() => edit(item)}>
                <PencilIcon />
              </TrayButton>
              <TrayButton
                label={t('queue.remove')}
                onClick={() => run(host('sessions.unqueue', { sessionId, itemId: item.id }))}
              >
                <XIcon />
              </TrayButton>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
