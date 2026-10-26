import { useEffect, useState } from 'react'
import { ArrowUpIcon, ListPlusIcon, SquareIcon } from 'lucide-react'
import { AnimatePresence } from 'motion/react'
import { Trans, useTranslation } from 'react-i18next'
import type { SessionView, UserContent } from '@shared/thread'
import { InputGroupButton } from '@renderer/components/ui/input-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { limitLabel, resetTime } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { formatShortcut, isMod } from '@renderer/lib/platform'
import { useAgentsStore } from '@renderer/stores/agents'
import { useSettingsStore } from '@renderer/stores/settings'
import { useThreadsStore } from '@renderer/stores/threads'
import { endedOnRejection } from '../turn-phase'
import { attachmentContent, attachmentsBlock } from './attachments'
import { ControlRow } from './control-row'
import { hasMessage } from './drafts'
import { OutOfCreditStrip } from './out-of-credit-strip'
import { PromptBox } from './prompt-box'
import { useOutOfCredit } from './use-out-of-credit'
import { usePromptBox } from './use-prompt-box'

/** The prompt box and the session's controls under it. */
export function Composer({ session, agentName }: { session: SessionView; agentName: string }) {
  const { t } = useTranslation('composer')
  const sessionId = session.id
  const sendKey = useSettingsStore((s) => s.settings.general.sendKey)
  const limits = useAgentsStore((s) => s.byId[session.agentId]?.limits)
  const steering = useAgentsStore((s) => !!s.byId[session.agentId]?.capabilities.steering)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const outOfCredit = useOutOfCredit(sessionId)
  const rejected = useThreadsStore((s) => endedOnRejection(s.replicas[sessionId]?.state))

  const status = session.status
  const starting = status === 'starting'
  const running = status === 'running' || status === 'awaiting_permission'
  const awaiting = status === 'awaiting_permission'
  // A closed session attaches to its agent as the message goes.
  const idle = status === 'ready' || status === 'closed'
  const box = usePromptBox({
    draft: sessionId,
    sessionId,
    projectPath: session.projectPath,
    disabled: starting,
  })
  const { text, attachments, error, setError } = box
  const blocked = attachmentsBlock(attachments, text)
  const holdsMessage = hasMessage(text, attachments)
  const canSend = idle && holdsMessage && !blocked
  // During a turn the send key queues the message and the steer key sends it into the turn.
  const canQueue = running && holdsMessage && !blocked
  const queueKey = sendKey === 'enter' ? 'Enter' : 'Mod+Enter'
  const steerKey = sendKey === 'enter' ? 'Mod+Enter' : 'Mod+Shift+Enter'
  const reached = limits?.find((l) => l.state === 'reached')
  // Claude Code turns on ultracode for a message that says the word; no config option sets it.
  const ultracode = session.agentId === 'claude-code' && /\bultracode\b/i.test(text)

  // Starting a session focuses the composer, as the reference does.
  useEffect(() => {
    if (status === 'ready' && document.activeElement === document.body) box.editor.current?.focus()
  }, [status, box.editor])

  // Both go through the host's queue, which sends at once when the session is free.
  const send = () => {
    if (canSend || canQueue) queue(false)
  }

  const queue = (steer: boolean) => {
    const taken = box.take()
    const content: UserContent[] = [
      ...(taken.prompt.trim() ? [{ type: 'text' as const, text: taken.prompt }] : []),
      ...attachmentContent(taken.held),
    ]
    host('sessions.queue', { sessionId, content })
      .then(({ itemId }) => {
        // Once queued, a failed steer leaves the message in the queue, not lost.
        if (steer && itemId) {
          host('sessions.steer', { sessionId, itemId }).catch((e: unknown) =>
            setError(errorMessage(e)),
          )
        }
      })
      .catch(box.restore(taken))
  }

  const cancel = () => {
    host('sessions.cancel', { sessionId }).catch((e: unknown) => setError(errorMessage(e)))
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && running) {
      event.preventDefault()
      cancel()
      return
    }
    if (event.key !== 'Enter') return
    const sends = sendKey === 'enter' ? !event.shiftKey && !isMod(event) : isMod(event)
    const steers =
      running &&
      steering &&
      (sendKey === 'enter' ? isMod(event) && !event.shiftKey : isMod(event) && event.shiftKey)
    if (steers) {
      event.preventDefault()
      if (canQueue) queue(true)
      return
    }
    if (!sends) return
    event.preventDefault()
    send()
  }

  const placeholder = starting
    ? t('prompt.placeholder.starting', { agent: agentName })
    : awaiting
      ? t('prompt.placeholder.awaiting')
      : running
        ? t(steering ? 'prompt.placeholder.steer' : 'prompt.placeholder.queue', {
            agent: agentName,
            queue: formatShortcut(queueKey),
            steer: formatShortcut(steerKey),
          })
        : reached?.resetsAt
          ? t('prompt.placeholder.limitReached', {
              limit: limitLabel(reached),
              time: resetTime(reached.resetsAt),
            })
          : rejected
            ? t('prompt.placeholder.denied', { agent: agentName })
            : t('prompt.placeholder.ask', { agent: agentName })

  const compact = session.commands.some((c) => c.name === 'compact')
    ? () => {
        if (!idle) return
        host('sessions.prompt', { sessionId, content: [{ type: 'text', text: '/compact' }] }).catch(
          (e: unknown) => setError(errorMessage(e)),
        )
      }
    : null

  return (
    <div className="flex flex-col">
      <PromptBox
        box={box}
        agentId={session.agentId}
        agentName={agentName}
        commands={session.commands}
        placeholder={placeholder}
        label={t('prompt.label', { agent: agentName })}
        size={{ minHeight: 'var(--composer-min)', padding: '16px 4px 16px 10px' }}
        onKeyDown={onKeyDown}
        wrap={!!outOfCredit}
        top={
          <AnimatePresence initial={false}>
            {outOfCredit && !starting && (
              <OutOfCreditStrip
                key={outOfCredit.id}
                sessionId={sessionId}
                notice={outOfCredit}
                config={session.config}
                onSwitchModel={() => setModelMenuOpen(true)}
              />
            )}
          </AnimatePresence>
        }
        end={
          <>
            {canQueue && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <InputGroupButton
                      key="queue"
                      size="round"
                      variant="quiet"
                      aria-label={t('prompt.queue')}
                      onClick={() => queue(false)}
                      className="animate-in zoom-in-75 fade-in animation-duration-(--duration-fast)"
                    />
                  }
                >
                  <ListPlusIcon />
                </TooltipTrigger>
                <TooltipContent>
                  <Trans
                    t={t}
                    i18nKey={steering ? 'prompt.queueSteerTooltip' : 'prompt.queueTooltip'}
                    values={{
                      queueShortcut: formatShortcut(queueKey),
                      steerShortcut: formatShortcut(steerKey),
                    }}
                    components={{ shortcut: <span className="opacity-60" /> }}
                  />
                </TooltipContent>
              </Tooltip>
            )}
            {running ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <InputGroupButton
                      key="stop"
                      size="round"
                      variant="default"
                      aria-label={t('prompt.stop')}
                      onClick={cancel}
                      className="animate-in zoom-in-75 fade-in animation-duration-(--duration-fast)"
                    />
                  }
                >
                  <SquareIcon className="size-3 fill-current" />
                </TooltipTrigger>
                <TooltipContent>
                  <Trans
                    t={t}
                    i18nKey="prompt.stopTooltip"
                    values={{ shortcut: 'Esc' }}
                    components={{ shortcut: <span className="opacity-60" /> }}
                  />
                </TooltipContent>
              </Tooltip>
            ) : blocked && holdsMessage ? (
              // A disabled button takes no pointer, so the tooltip says why from around it.
              <Tooltip>
                <TooltipTrigger render={<span key="send" />}>
                  <InputGroupButton
                    size="round"
                    variant="secondary"
                    aria-label={t('prompt.send')}
                    disabled
                    className="disabled:text-disabled disabled:opacity-100"
                  >
                    <ArrowUpIcon />
                  </InputGroupButton>
                </TooltipTrigger>
                <TooltipContent>{blocked.message}</TooltipContent>
              </Tooltip>
            ) : (
              <InputGroupButton
                key="send"
                size="round"
                variant={canSend ? 'default' : 'secondary'}
                aria-label={t('prompt.send')}
                disabled={!canSend}
                onClick={send}
                className="animate-in zoom-in-75 fade-in animation-duration-(--duration-fast) disabled:text-disabled disabled:opacity-100"
              >
                <ArrowUpIcon />
              </InputGroupButton>
            )}
          </>
        }
      />
      {/* Holds the row's height while the agent starts, so nothing jumps when the options arrive. */}
      <div className="flex min-h-9 flex-col">
        {(error || blocked?.notice) && (
          <p className="animate-in px-2 pt-1 text-xs text-danger fade-in" role="alert">
            {error ?? blocked?.message}
          </p>
        )}
        {!starting && (
          <ControlRow
            session={session}
            onCompact={compact}
            ultracode={ultracode}
            modelMenu={{ open: modelMenuOpen, onOpenChange: setModelMenuOpen }}
            outOfCredit={!!outOfCredit}
          />
        )}
      </div>
    </div>
  )
}
