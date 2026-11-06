import { useEffect, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { cacheExpiry } from '@shared/prompt-cache'
import type { SessionView, UserContent } from '@shared/thread'
import { ChatComposer } from '@renderer/components/affect/chat-composer'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { BranchTrayLink } from '@renderer/features/git/git-status'
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
import { TrayStyles } from './affect-styles'
import { attachmentContent, attachmentsBlock } from './attachments'
import { OptionMenu } from './control-row'
import { useModeControl } from './mode-control'
import { isSelect, onCycleKeys } from './options'
import { hasMessage } from './drafts'
import { HistoryHeader } from './history-header'
import { levelsOf, type SelectOption } from './levels'
import { shownChoice } from './model-list'
import { ModelMenu } from './model-menu'
import { nextChoice, nextMode } from './modes'
import { OutOfCreditStrip } from './out-of-credit-strip'
import { useAddMenu } from './add-menu'
import { PromptBox } from './prompt-box'
import { RunningButton, SendButton } from './send-button'
import { CacheButton, ContextButton } from './usage'
import { useOutOfCredit } from './use-out-of-credit'
import type { Select } from './use-pick'
import { usePromptBox } from './use-prompt-box'

/**
 * The session's composer on affectUI's Chat Composer: the white card with **+**, the permission
 * mode, the model menu and Send over the text, and the gray tray with the branch, the prompt
 * cache and the context under it.
 */
export function Composer({ session, agentName }: { session: SessionView; agentName: string }) {
  const { t } = useTranslation('composer')
  const sessionId = session.id
  const sendKey = useSettingsStore((s) => s.settings.general.sendKey)
  const agent = useAgentsStore((s) => s.byId[session.agentId])
  const limits = agent?.limits
  const steering = !!agent?.capabilities.steering
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [configError, setConfigError] = useState<string | null>(null)
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
  const add = useAddMenu({ box, agentName, commands: session.commands })

  const config = session.config
  const mode = config.find((o): o is SelectOption => o.category === 'mode' && isSelect(o))
  const model = config.find((o): o is SelectOption => o.category === 'model' && isSelect(o))
  const effort = config.find((o) => o.category === 'thought_level' && isSelect(o))
  const switches = config.filter((o) => o.type === 'boolean')
  const others = config.filter(
    (o): o is SelectOption => isSelect(o) && o !== mode && o !== model && o !== effort,
  )
  const leftOthers = others.filter((o) => o.category === 'other')
  const rightOthers = others.filter((o) => o.category !== 'other')

  const set: Select = (optionId, value) => {
    setConfigError(null)
    return host('sessions.setConfigOption', { sessionId, optionId, value }).then(
      () => true,
      (e: unknown) => {
        setConfigError(errorMessage(e))
        return false
      },
    )
  }
  const modeControl = useModeControl(mode, set)

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
    const option = config.find((o) => o.category === category && o.type === 'select')
    if (!option?.choices?.length) return false
    const reported = option.value === undefined ? undefined : String(option.value)
    const asked = stepped.current[option.id]
    const current = asked && asked.from === reported ? asked.to : reported
    const model = config.find((o) => o.category === 'model')?.value
    const levels =
      category === 'mode'
        ? null
        : levelsOf(option as SelectOption, current, typeof model === 'string' ? model : undefined)
    const next = levels
      ? nextChoice(levels.levels, levels.shown)
      : nextMode(option.choices, current)
    if (next === undefined || next === current) return true
    stepped.current[option.id] = { from: reported, to: next }
    host('sessions.setConfigOption', { sessionId, optionId: option.id, value: next }).catch(
      (e: unknown) => setError(errorMessage(e)),
    )
    return true
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (onCycleKeys(event, cycle)) {
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

  const cache = cacheExpiry(session, agent?.account ?? null)
  const timed = cache?.expiresAt != null ? cache : null
  const modelName = model
    ? (shownChoice(model.choices, String(model.value))?.name ?? String(model.value))
    : null
  const sendControl = running ? (
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
      <TooltipTrigger render={<span key="send" className="kettu-send-wrap" />}>
        <SendButton disabled label={t('prompt.send')} />
      </TooltipTrigger>
      <TooltipContent>{blocked.message}</TooltipContent>
    </Tooltip>
  ) : (
    <SendButton key="send" disabled={!canSend} label={t('prompt.send')} onClick={send} />
  )
  const shownError = error ?? (blocked?.notice ? blocked.message : null) ?? configError

  return (
    <div data-composer="" className="kettu-composer" data-starting={starting || undefined}>
      <ChatComposer
        field={
          <PromptBox
            box={box}
            agentId={session.agentId}
            agentName={agentName}
            commands={session.commands}
            placeholder={placeholder}
            label={t('prompt.label', { agent: agentName })}
            size={{ minHeight: '40px', padding: '0', lineHeight: '20px' }}
            onKeyDown={onKeyDown}
            top={
              <>
                {box.historyPosition && <HistoryHeader position={box.historyPosition} />}
                <AnimatePresence initial={false}>
                  {outOfCredit && !starting && (
                    <OutOfCreditStrip
                      key={outOfCredit.id}
                      sessionId={sessionId}
                      notice={outOfCredit}
                      config={config}
                      onSwitchModel={() => setModelMenuOpen(true)}
                    />
                  )}
                </AnimatePresence>
                {selection && (
                  <SelectionChip selection={selection} onRemove={() => setPaneSelection(null)} />
                )}
              </>
            }
          />
        }
        onFieldFocus={box.focus}
        addSections={add.sections}
        onAttach={add.onAttach}
        addDisabled={add.disabled}
        {...modeControl}
        start={
          !starting && leftOthers.map((o) => <OptionMenu key={o.id} option={o} onSelect={set} />)
        }
        extra={
          !starting &&
          rightOthers.map((o) => <OptionMenu key={o.id} option={o} onSelect={set} align="end" />)
        }
        modelSlot={
          !starting &&
          (model || effort || switches.length > 0) && (
            <ModelMenu
              agentId={session.agentId}
              agentName={agent?.name ?? agentName}
              config={config}
              running={running}
              onSelect={set}
              open={modelMenuOpen}
              onOpenChange={setModelMenuOpen}
              outOfCredit={!!outOfCredit}
              account={agent?.account ?? null}
              limits={limits ?? []}
              source={agent?.version ? `${agent.harnessName} ${agent.version}` : null}
            />
          )
        }
        models={[]}
        voice={false}
        send={sendControl}
        labels={{
          composer: t('prompt.label', { agent: agentName }),
          add: t('attachments.add'),
          addMenu: t('attachments.add'),
          approvalMenu: t('controls.permissionMode'),
          selected: (label) => t('controls.selected', { label }),
        }}
        foot={
          <div className="ui-as-composer__tray kettu-tray">
            <TrayStyles />
            <span className="kettu-tray__group">
              <BranchTrayLink projectPath={session.projectPath} />
            </span>
            {shownError && (
              <p className="kettu-tray__error" role="alert" title={shownError}>
                {shownError}
              </p>
            )}
            <span className="kettu-tray__group">
              <CacheButton cache={timed} running={running} used={session.usage?.used ?? 0} />
              <ContextButton
                sessionId={sessionId}
                agentId={session.agentId}
                idle={!running && !starting}
                reports={agent?.capabilities.context ?? false}
                direct={agent?.capabilities.liveContext ?? false}
                live={running && (agent?.capabilities.liveContext ?? false)}
                usage={session.usage}
                context={session.context}
                limits={limits ?? []}
                account={agent?.account ?? null}
                model={modelName}
              />
            </span>
          </div>
        }
      />
    </div>
  )
}

/** The keys that send a message into the running turn, as the placeholder names them. */
function steerKeys(sendKey: string): string {
  if (isMac) return sendKey === 'enter' ? '⌘↩' : '⇧⌘↩'
  return sendKey === 'enter' ? 'Ctrl+Enter' : 'Ctrl+Shift+Enter'
}
