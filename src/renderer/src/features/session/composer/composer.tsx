import { useEffect, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { useTranslation } from 'react-i18next'
import type { SessionView, UserContent } from '@shared/thread'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { limitLabel, resetTime } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { isMac, isMod } from '@renderer/lib/platform'
import { selectionPrompt } from '@renderer/features/artifacts/anchors'
import { SelectionChip } from '@renderer/features/artifacts/selection-chip'
import { usePane } from '@renderer/features/split/pane-context'
import { useAgentsStore } from '@renderer/stores/agents'
import { setPaneSelection, useArtifactsStore } from '@renderer/stores/artifacts'
import { useSettingsStore } from '@renderer/stores/settings'
import { useThreadsStore } from '@renderer/stores/threads'
import { useViewStore } from '@renderer/stores/view'
import { endedOnRejection } from '../turn-phase'
import { attachmentContent, attachmentsBlock } from './attachments'
import { ControlRow } from './control-row'
import { hasMessage } from './drafts'
import { HistoryHeader } from './history-header'
import { levelsOf, type SelectOption } from './levels'
import { nextChoice, nextMode } from './modes'
import { OutOfCreditStrip } from './out-of-credit-strip'
import { AddMenu, PromptBox } from './prompt-box'
import { RunningButton, SendButton } from './send-button'
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
  // An element picked in the artifact beside this thread goes with the next message.
  const picked = useArtifactsStore((s) =>
    s.paneSelection?.projectPath === session.projectPath ? s.paneSelection : null,
  )
  const beside = useViewStore(
    (s) =>
      picked !== null &&
      s.sidePane[sessionId] === 'artifact' &&
      s.sideArtifact[sessionId] === picked.artifactId,
  )
  const selection = beside ? picked : null

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

  // Starting a session focuses its composer, in the pane in focus only.
  const focused = usePane()?.focused ?? true
  useEffect(() => {
    if (!focused) return
    if (status === 'ready' && document.activeElement === document.body) box.editor.current?.focus()
  }, [status, focused, box.editor])

  // Both go through the host's queue, which sends at once when the session is free.
  const send = () => {
    if (canSend || canQueue) queue(false)
  }

  const queue = (steer: boolean) => {
    const taken = box.take()
    const sent = selection && taken.prompt.trim() ? selection : null
    const prompt = sent ? selectionPrompt(taken.prompt, sent) : taken.prompt
    if (sent) setPaneSelection(null)
    const content: UserContent[] = [
      ...(prompt.trim() ? [{ type: 'text' as const, text: prompt }] : []),
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
      .catch((reason: unknown) => {
        if (sent) setPaneSelection(sent)
        box.restore(taken)(reason)
      })
  }

  const cancel = () => {
    host('sessions.cancel', { sessionId }).catch((e: unknown) => setError(errorMessage(e)))
  }

  // A step asked for and not yet reported, so quick presses keep stepping from it.
  const stepped = useRef<Record<string, { from: string | undefined; to: string }>>({})
  // Shift+Tab steps through the permission modes and Alt+E through the effort levels.
  const cycle = (category: 'mode' | 'thought_level') => {
    const option = session.config.find((o) => o.category === category && o.type === 'select')
    if (!option?.choices?.length) return false
    const reported = option.value === undefined ? undefined : String(option.value)
    const asked = stepped.current[option.id]
    const current = asked && asked.from === reported ? asked.to : reported
    const next =
      category === 'mode'
        ? nextMode(option.choices, current)
        : nextChoice(levelsOf(option as SelectOption, current).levels, current)
    if (next === undefined || next === current) return true
    stepped.current[option.id] = { from: reported, to: next }
    host('sessions.setConfigOption', { sessionId, optionId: option.id, value: next }).catch(
      (e: unknown) => setError(errorMessage(e)),
    )
    return true
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const plain = !isMod(event) && !event.altKey
    if (
      (event.key === 'Tab' && event.shiftKey && plain && cycle('mode')) ||
      (event.code === 'KeyE' &&
        event.altKey &&
        !event.shiftKey &&
        !isMod(event) &&
        // A layout whose Option+E types a character, as the euro sign, keeps it.
        !(event.key.length === 1 && event.key.toLowerCase() !== 'e') &&
        cycle('thought_level'))
    ) {
      event.preventDefault()
      return
    }
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
      : !running && reached?.resetsAt
        ? t('prompt.placeholder.limitReached', {
            limit: limitLabel(reached),
            time: resetTime(reached.resetsAt),
          })
        : !running && rejected
          ? t('prompt.placeholder.denied', { agent: agentName })
          : running
            ? steering
              ? t('prompt.placeholder.running', { keys: steerKeys(sendKey) })
              : t('prompt.placeholder.runningQueue')
            : t('prompt.placeholder.ask', { agent: agentName })

  return (
    <div data-composer="" className="flex flex-col">
      <PromptBox
        box={box}
        agentId={session.agentId}
        agentName={agentName}
        commands={session.commands}
        placeholder={placeholder}
        label={t('prompt.label', { agent: agentName })}
        size={{
          minHeight: 'calc(var(--spacing) * 9)',
          padding: 'calc(var(--spacing) * 2) 0',
          lineHeight: 'calc(var(--spacing) * 5)',
        }}
        onKeyDown={onKeyDown}
        wrap={!!outOfCredit || !!selection || !!box.historyPosition}
        top={
          <>
            {box.historyPosition && <HistoryHeader position={box.historyPosition} />}
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
            {selection && (
              <SelectionChip selection={selection} onRemove={() => setPaneSelection(null)} />
            )}
          </>
        }
        end={
          running ? (
            <RunningButton
              holds={canQueue}
              steering={steering}
              queueKey={queueKey}
              steerKey={steerKey}
              onStop={cancel}
              onQueue={() => queue(false)}
              onSteer={() => queue(true)}
            />
          ) : blocked && holdsMessage ? (
            // A disabled button takes no pointer, so the tooltip says why from around it.
            <Tooltip>
              <TooltipTrigger render={<span key="send" />}>
                <SendButton disabled label={t('prompt.send')} />
              </TooltipTrigger>
              <TooltipContent>{blocked.message}</TooltipContent>
            </Tooltip>
          ) : (
            <SendButton key="send" disabled={!canSend} label={t('prompt.send')} onClick={send} />
          )
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
            addMenu={<AddMenu box={box} agentName={agentName} commands={session.commands} />}
            modelMenu={{ open: modelMenuOpen, onOpenChange: setModelMenuOpen }}
            outOfCredit={!!outOfCredit}
          />
        )}
      </div>
    </div>
  )
}

/** The keys that send a message into the running turn, as the placeholder names them. */
function steerKeys(sendKey: string): string {
  if (isMac) return sendKey === 'enter' ? '⌘↩' : '⇧⌘↩'
  return sendKey === 'enter' ? 'Ctrl+Enter' : 'Ctrl+Shift+Enter'
}
