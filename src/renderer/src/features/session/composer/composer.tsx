import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDataTransferHorizontalIcon } from '@hugeicons/core-free-icons'
import { AnimatePresence } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { cacheExpiry } from '@shared/prompt-cache'
import type { AgentId, ConfigOption, SessionView, UserContent } from '@shared/thread'
import { ChatComposer } from '@renderer/components/affect/chat-composer'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { BranchTrayLink } from '@renderer/features/git/git-status'
import { limitLabel, resetTime } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { isMac, isMod } from '@renderer/lib/platform'
import { selectionPrompt } from '@renderer/features/artifacts/anchors'
import { SelectionChip } from '@renderer/features/artifacts/selection-chip'
import { usePane } from '@renderer/features/split/pane-context'
import { optionsOn, useAgentOptionsStore } from '@renderer/stores/agent-options'
import {
  setPendingSwitch,
  updatePendingSwitch,
  useAgentSwitchStore,
} from '@renderer/stores/agent-switch'
import { agentsOn, useAgentsStore } from '@renderer/stores/agents'
import { hostOfSession } from '@renderer/stores/sessions'
import { AgentMarkHost } from '@renderer/components/agents/agent-mark-host'
import { AgentMenu } from '@renderer/features/session/new-session/agent-menu'
import { readFirstOptions } from '@renderer/features/session/new-session/prepared'
import { startConfig } from '@renderer/features/session/new-session/start-options'
import { Glyph } from '@renderer/features/shell/glyph'
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
import { SessionPlace } from './session-place'
import { SwitchStrip } from './switch-strip'
import { CacheButton, ContextButton } from './usage'
import { useOutOfCredit } from './use-out-of-credit'
import type { Select } from './use-pick'
import { useBlockedEnter } from './use-blocked-enter'
import { usePromptBox } from './use-prompt-box'
import { useSessionFolder } from '@renderer/lib/session-folder'
import { firstWaiting, pressWaitingCard } from '../waiting-card'

const valuesOf = (config: readonly ConfigOption[]): Record<string, string | boolean> =>
  Object.fromEntries(config.map((o) => [o.id, o.value]))

/**
 * The session's composer on affectUI's Chat Composer: the white card with **+**, the permission
 * mode, the model menu and Send over the text, and the gray tray under it: the host, the project
 * and the branch, then the prompt cache and the context. With `mustSwitch`, its agent can no
 * longer go on, so a message goes only once another agent is picked.
 */
export function Composer({
  session,
  agentName: ownName,
  mustSwitch = false,
}: {
  session: SessionView
  agentName: string
  mustSwitch?: boolean
}) {
  const { t } = useTranslation(['composer', 'session'])
  const sessionId = session.id
  // Another agent picked to take the session over with the next message, shown as its own.
  const pending = useAgentSwitchStore((s) => s.pending[sessionId] ?? null)
  // Every agent here is one of the host the session is on.
  const hostId = hostOfSession(session)
  const pendingEntry = useAgentOptionsStore((s) =>
    pending ? optionsOn(s, hostId)[pending.agentId] : undefined,
  )
  const pendingName = useAgentsStore((s) =>
    pending ? agentsOn(s, hostId).byId[pending.agentId]?.name : undefined,
  )
  const pendingConfig = useMemo(
    () =>
      pending
        ? pendingEntry
          ? startConfig(pendingEntry, pending.values, { startMode: true })
          : []
        : null,
    [pending, pendingEntry],
  )
  const [choosingAgent, setChoosingAgent] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  // Switch agent opens the agent menu in the model menu's place. Closed back into the model menu,
  // whose button went away with it, that button takes the focus, unless the user moved it away.
  const closeAgentMenu = (reason?: string) => {
    setChoosingAgent(false)
    if (reason === 'outside-press' || reason === 'focus-out') return
    requestAnimationFrame(() =>
      root.current?.querySelector<HTMLElement>('.ui-mdpc__trigger')?.focus(),
    )
  }
  const pendingAgent = pending?.agentId ?? null
  const pendingKnown = !!pendingEntry && !pendingEntry.provisional
  useEffect(() => {
    // Its modes come with its own defaults, which a session it only resumed did not report.
    if (pendingAgent && !pendingKnown) void readFirstOptions(hostId, pendingAgent)
  }, [hostId, pendingAgent, pendingKnown])
  const agentName = pendingName ?? ownName
  const sendKey = useSettingsStore((s) => s.settings.general.sendKey)
  const agent = useAgentsStore((s) => agentsOn(s, hostId).byId[session.agentId])
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
  const folder = useSessionFolder(sessionId) ?? session.projectPath
  const box = usePromptBox({
    draft: sessionId,
    sessionId,
    projectPath: folder,
    hostId,
    disabled: starting,
  })
  const { text, attachments, error, setError } = box
  const blocked = attachmentsBlock(attachments, text)
  const holdsMessage = hasMessage(text, attachments)
  const canSend = idle && holdsMessage && !blocked && (!mustSwitch || pending !== null)
  // During a turn the send key queues the message and the steer key sends it into the turn.
  const canQueue = running && holdsMessage && !blocked && pending === null && !mustSwitch
  // Why the send key does nothing now, for the line under the box.
  const unsendable =
    mustSwitch && !pending
      ? t('session:newSession.chooseAgentFirst')
      : starting
        ? t('prompt.waitForStart', { agent: agentName })
        : (blocked?.message ?? null)
  const queueKey = sendKey === 'enter' ? 'Enter' : 'Mod+Enter'
  const steerKey = sendKey === 'enter' ? 'Mod+Enter' : 'Mod+Shift+Enter'
  const reached = limits?.find((l) => l.state === 'reached')
  const add = useAddMenu({ box, agentName, commands: session.commands })

  // An agent that is gone takes no settings; the one picked to carry on shows its own.
  const config = pendingConfig ?? (mustSwitch ? [] : session.config)
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
    if (pending) {
      updatePendingSwitch(sessionId, { values: { ...pending.values, [optionId]: value } })
      return Promise.resolve(true)
    }
    return host('sessions.setConfigOption', { sessionId, optionId, value }).then(
      () => true,
      (e: unknown) => {
        setConfigError(errorMessage(e))
        return false
      },
    )
  }
  const modeControl = useModeControl(mode, set)

  // A session shown, started or done with its turn focuses its composer, in the pane in focus
  // only, when the focus is nowhere else, as after New session's composer gave way to it.
  const focused = usePane()?.focused ?? true
  const ready = status === 'ready'
  useEffect(() => {
    if (!focused || starting) return
    if (document.activeElement === document.body) box.editor.current?.focus()
  }, [starting, ready, focused, box.editor])

  // Both go through the host's queue, which sends at once when the session is free; a message
  // that hands the session to another agent goes as that agent's first turn.
  const send = () => {
    if (pending && canSend) handOver()
    else if (canSend || canQueue) queue(false)
  }
  const blockedEnter = useBlockedEnter({
    reason: unsendable,
    waiting: unsendable !== null && unsendable === blocked?.message && blocked.adding,
    text,
    attachments,
    send,
  })

  const takeContent = () => {
    const taken = box.take()
    const sent = selection && taken.prompt.trim() ? selection : null
    const prompt = sent ? selectionPrompt(taken.prompt, sent) : taken.prompt
    if (sent) setPaneSelection(null)
    const content: UserContent[] = [
      ...(prompt.trim() ? [{ type: 'text' as const, text: prompt }] : []),
      ...attachmentContent(taken.held),
    ]
    return { taken, sent, content }
  }

  const handOver = () => {
    if (!pending) return
    const { taken, sent, content } = takeContent()
    const options = Object.keys(pending.values).length > 0 ? { options: pending.values } : {}
    host('sessions.switchAgent', {
      sessionId,
      agentId: pending.agentId,
      content,
      ...options,
      ...(pending.summarize ? { summarize: true } : {}),
    })
      .then(() => setPendingSwitch(sessionId, null))
      .catch((reason: unknown) => {
        if (sent) setPaneSelection(sent)
        box.restore(taken)(reason)
      })
  }

  // Picking a model of another agent makes it the pending one; the session's own agent undoes it.
  const chooseAgent = (agentId: AgentId, modelValue: string | null) => {
    setChoosingAgent(false)
    if (agentId === session.agentId && !mustSwitch) {
      setPendingSwitch(sessionId, null)
      const own = session.config.find((o) => o.category === 'model')
      if (own && modelValue !== null && modelValue !== own.value) void set(own.id, modelValue)
      return
    }
    const entry = optionsOn(useAgentOptionsStore.getState(), hostId)[agentId]
    const modelId = entry?.config.find((o) => o.category === 'model')?.id
    setPendingSwitch(sessionId, {
      agentId,
      values: modelId && modelValue !== null ? { [modelId]: modelValue } : {},
      summarize: pending?.summarize ?? false,
    })
  }

  const queue = (steer: boolean) => {
    const { taken, sent, content } = takeContent()
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
    if (pending) {
      void set(option.id, next)
      return true
    }
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
      // A card waiting for the user takes Esc as its Deny, as its button shows, and the turn goes on;
      // with a message being written, Esc answers nothing, as Enter and the number keys do.
      if (firstWaiting(sessionId)) {
        if (!holdsMessage) pressWaitingCard(sessionId, 'escape')
      } else cancel()
      return
    }
    if (event.key !== 'Enter') return
    // With nothing written, Enter and Mod+Enter answer the waiting card, as its buttons show.
    const cardKey = isMod(event) ? 'confirm' : event.metaKey || event.ctrlKey ? null : 'enter'
    if (
      !holdsMessage &&
      !event.shiftKey &&
      !event.altKey &&
      !event.isComposing &&
      cardKey &&
      pressWaitingCard(sessionId, cardKey)
    ) {
      event.preventDefault()
      return
    }
    const sends = sendKey === 'enter' ? !event.shiftKey : isMod(event)
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
    if (canSend || canQueue) send()
    else if (holdsMessage) blockedEnter.enter()
  }

  const placeholder = starting
    ? t('prompt.placeholder.starting', { agent: agentName })
    : mustSwitch && !pending
      ? t('prompt.placeholder.pickAgent')
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
  const shownError =
    error ??
    (blocked && !blocked.adding ? blocked.message : null) ??
    blockedEnter.refused ??
    configError

  return (
    <div
      ref={root}
      data-composer=""
      className="kettu-composer"
      data-starting={starting || undefined}
    >
      <ChatComposer
        field={
          <PromptBox
            box={box}
            agentId={session.agentId}
            hostId={hostId}
            agentName={agentName}
            commands={session.commands}
            placeholder={placeholder}
            label={t('prompt.label', { agent: agentName })}
            size={{
              minHeight: 'calc(2 * var(--prose-size) + 14px)',
              padding: '0',
              lineHeight: 'calc(var(--prose-size) + 7px)',
            }}
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
                <AnimatePresence initial={false}>
                  {pending && (
                    <SwitchStrip
                      key="switch"
                      agentName={agentName}
                      config={config}
                      summarize={pending.summarize}
                      onSummarize={(on) => updatePendingSwitch(sessionId, { summarize: on })}
                      {...(mustSwitch ? {} : { onUndo: () => setPendingSwitch(sessionId, null) })}
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
          // An agent with no model menu switches from the agent menu itself.
          (pending || choosingAgent || mustSwitch || !(model || effort || switches.length > 0) ? (
            <AgentMenu
              agentId={pending?.agentId ?? (mustSwitch ? null : session.agentId)}
              values={pending ? pending.values : valuesOf(session.config)}
              onValues={(optionId, value) => void set(optionId, value)}
              onChoose={chooseAgent}
              hostId={hostId}
              defaultOpen={choosingAgent}
              onClose={closeAgentMenu}
            />
          ) : (
            <ModelMenu
              agentId={session.agentId}
              hostId={hostId}
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
              actions={[
                {
                  id: 'switch-agent',
                  label: t('switchAgent.menu'),
                  icon: <Glyph icon={ArrowDataTransferHorizontalIcon} />,
                  disabled: !idle,
                  ...(idle ? {} : { hint: t('switchAgent.betweenTurns') }),
                  onSelect: () => setChoosingAgent(true),
                },
              ]}
            />
          ))
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
              <SessionPlace sessionId={sessionId} projectPath={session.projectPath} />
              <BranchTrayLink projectPath={folder} />
            </span>
            {shownError && (
              <p className="kettu-tray__error" role="alert" title={shownError}>
                {shownError}
              </p>
            )}
            <span className="kettu-tray__group kettu-tray__group--end">
              <CacheButton cache={timed} running={running} used={session.usage?.used ?? 0} />
              <AgentMarkHost.Provider value={hostId}>
                <ContextButton
                  sessionId={sessionId}
                  agentId={session.agentId}
                  idle={!running && !starting}
                  closed={status === 'closed'}
                  reports={agent?.capabilities.context ?? false}
                  direct={agent?.capabilities.liveContext ?? false}
                  live={running && (agent?.capabilities.liveContext ?? false)}
                  usage={session.usage}
                  context={session.context}
                  limits={limits ?? []}
                  account={agent?.account ?? null}
                  model={modelName}
                />
              </AgentMarkHost.Provider>
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
