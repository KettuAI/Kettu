import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { cacheExpiry, knownExpiry } from '@shared/prompt-cache'
import {
  QUEUED_COMMENTS_TEXT,
  type AgentId,
  type ConfigOption,
  type SessionView,
  type UserContent,
} from '@shared/thread'
import { ChatComposer } from '@renderer/components/affect/chat-composer'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useCachePhase } from '@renderer/features/prompt-cache/cache-phase'
import { BranchTrayLink } from '@renderer/features/git/git-status'
import { limitPhrase, resetTime } from '@renderer/lib/format'
import { onAppEvent } from '@renderer/app/events'
import { errorMessage, host } from '@renderer/lib/host'
import { newestLimits } from '@renderer/lib/plan-readings'
import { isMod } from '@renderer/lib/platform'
import { selectionPrompt } from '@renderer/features/artifacts/anchors'
import { SelectionChip } from '@renderer/features/artifacts/selection-chip'
import { usePane } from '@renderer/features/split/pane-context'
import { optionsOn, useAgentOptionsStore } from '@renderer/stores/agent-options'
import {
  setPendingSwitch,
  updatePendingSwitch,
  useAgentSwitchStore,
} from '@renderer/stores/agent-switch'
import { agentsOn, useAgentsStore, usePlanReadings } from '@renderer/stores/agents'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { taskFrom, useTasksStore } from '@renderer/stores/tasks'
import { AgentMarkHost } from '@renderer/components/agents/agent-mark-host'
import { AgentMenu } from '@renderer/features/session/new-session/agent-menu'
import { readFirstOptions } from '@renderer/features/session/new-session/prepared'
import { startConfig } from '@renderer/features/session/new-session/start-options'
import { runningWorkOf, workItems, type WorkItem } from '@renderer/features/sidebar/running-work'
import { setPaneSelection, useArtifactsStore } from '@renderer/stores/artifacts'
import { useSettingsStore } from '@renderer/stores/settings'
import { showSending, useThreadsStore } from '@renderer/stores/threads'
import { artifactShown, useViewStore } from '@renderer/stores/view'
import { askSide, openSideChat, sideQuestionOf } from '@renderer/stores/side-chat'
import {
  commentsOf,
  keepComments,
  removeComments,
  useReplyComments,
} from '@renderer/stores/reply-comments'
import { commentsMessage } from '../entries/reply-quote'
import { CommentList } from './comment-list'
import { awaitsAnswer, endedOnRejection } from '../turn-phase'
import { TrayStyles } from './affect-styles'
import { attachmentContent, attachmentsBlock, type AttachmentsBlock } from './attachments'
import { mentionResolver, NO_SURFACES, pluginRefs, surfaceRefs } from './chips'
import { mentionSurfacesOf } from './mention-surfaces'
import { OptionMenu } from './control-row'
import { useModeControl } from './mode-control'
import { isSelect, onCycleKeys } from './options'
import { hasMessage } from './drafts'
import { HistoryHeader } from './history-header'
import { RewoundHeader } from './rewound-header'
import { dialStops, type SelectOption } from './levels'
import { shownChoice } from './model-list'
import { ModelMenu } from './model-menu'
import { nextChoice, nextMode } from './modes'
import { HeldStrip } from './held-strip'
import { OutOfCreditStrip } from './out-of-credit-strip'
import { useAddMenu } from './add-menu'
import { builtinCommands } from './builtin-commands'
import { PromptBox } from './prompt-box'
import { CACHE_NOTICE_MIN_TOKENS, CacheNotice } from './cache-notice'
import { QueueButton, SendButton, StopButton } from './send-button'
import { SessionPlace } from './session-place'
import { SwitchConfirm } from './switch-confirm'
import { SwitchStrip } from './switch-strip'
import { SpeedButton } from './speed'
import { CacheButton, ContextButton } from './usage'
import { useOutOfCredit } from './use-out-of-credit'
import type { Select } from './use-pick'
import { useBlockedEnter } from './use-blocked-enter'
import { useSlashCommands } from './use-slash-commands'
import { useBoxText, usePromptBox } from './use-prompt-box'
import { useSessionFolder } from '@renderer/lib/session-folder'
import { firstWaiting, pressWaitingCard } from '../waiting-card'
import { limitsForModel } from '@shared/plan-limits'
import { usePhoneWindow } from '@renderer/features/shell/narrow'

const valuesOf = (config: readonly ConfigOption[]): Record<string, string | boolean> =>
  Object.fromEntries(config.map((o) => [o.id, o.value]))

/** How soon a session's composers ask its host again to attach it as the user types. */
const ATTACH_AGAIN_MS = 60_000
const attachAsked = new Map<string, number>()

/**
 * Asks the host to attach a session whose agent was let go, as the user starts writing to it, so
 * the message need not wait for the agent to start. The host does it only for an agent that gains
 * from it, and lets the agent go again when no message follows.
 */
function attachWhileTyping(sessionId: string): void {
  const now = Date.now()
  if (now - (attachAsked.get(sessionId) ?? -Infinity) < ATTACH_AGAIN_MS) return
  attachAsked.set(sessionId, now)
  // The send attaches it all the same, and says what failed.
  host('sessions.attachEarly', { sessionId }).catch(() => {})
}

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
  // A task this conversation started still runs; what is said here goes to this agent alone.
  const taskRunning = useTasksStore((s) => taskFrom(s.summaries, sessionId)?.status === 'running')
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
  const readings = usePlanReadings()
  const limits = agent ? newestLimits(readings, agent) : undefined
  const steering = !!agent?.capabilities.steering
  // A phone has no keys to name.
  const phone = usePhoneWindow()
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  // The models the agent offers may have changed since the session started.
  useEffect(() => {
    if (!modelMenuOpen) return
    host('sessions.refreshModels', { sessionId }).catch((error: unknown) =>
      console.warn(`Could not read the agent's models again: ${errorMessage(error)}`),
    )
  }, [modelMenuOpen, sessionId])
  const [configError, setConfigError] = useState<string | null>(null)
  const outOfCredit = useOutOfCredit(sessionId)
  const rejected = useThreadsStore((s) => endedOnRejection(s.replicas[sessionId]?.state))
  const asked = useThreadsStore((s) => awaitsAnswer(s.replicas[sessionId]?.state))
  // An element picked in the artifact beside this thread goes with the next message.
  const picked = useArtifactsStore((s) =>
    s.paneSelection?.projectPath === session.projectPath ? s.paneSelection : null,
  )
  const beside = useViewStore(
    (s) => picked !== null && artifactShown(s, sessionId, picked.artifactId),
  )
  const selection = beside ? picked : null

  const status = session.status
  const starting = status === 'starting'
  const running = status === 'running' || status === 'awaiting_permission'
  const awaiting = status === 'awaiting_permission'
  // A terminal that has the session open writes to it, so nothing is sent until it lets go.
  const heldOutside = session.heldOutside === true
  // A closed session attaches to its agent as the message goes.
  const idle = (status === 'ready' || status === 'closed') && !heldOutside
  const folder = useSessionFolder(sessionId) ?? session.projectPath
  const box = usePromptBox({
    draft: sessionId,
    sessionId,
    projectPath: folder,
    hostId,
    disabled: starting,
  })
  const { attachments, error, setError } = box
  /** Whether a message can go now, as it is or into the queue. */
  const can = (holds: boolean, blocked: AttachmentsBlock | null) => ({
    canSend: idle && holds && !blocked && (!mustSwitch || pending !== null),
    // During a turn the send key queues the message and the steer key sends it into the turn.
    canQueue: running && holds && !blocked && pending === null && !mustSwitch,
  })
  // Comments on passages go with the message, so with one, Send works on an empty box.
  const commented = useReplyComments(sessionId).length > 0
  // Read as values, so typing renders the composer only when one of them changes.
  const holdsMessage = useBoxText(box, (text) => hasMessage(text, attachments)) || commented
  const blockedBy = useBoxText(box, (text) => attachmentsBlock(attachments, text)?.message ?? null)
  const blocked = blockedBy === null ? null : attachmentsBlock(attachments, box.source.text)
  const { canSend, canQueue } = can(holdsMessage, blocked)
  // Starting a message, not opening the session with a draft in it, attaches a closed session.
  const held = useRef(holdsMessage)
  useEffect(() => {
    const began = holdsMessage && !held.current
    held.current = holdsMessage
    if (began && status === 'closed' && !heldOutside && !pending && !mustSwitch) {
      attachWhileTyping(sessionId)
    }
  }, [holdsMessage, status, heldOutside, pending, mustSwitch, sessionId])
  // The message as a key comes, from the editor itself, which a render may not have caught up with.
  const live = () => {
    const text = box.editor.current?.text() ?? box.source.text
    const holds = hasMessage(text, attachments) || commentsOf(sessionId).length > 0
    return { holds, ...can(holds, attachmentsBlock(attachments, text)) }
  }
  // Why the send key does nothing now, for the line under the box.
  const unsendable =
    mustSwitch && !pending
      ? t('session:newSession.chooseAgentFirst')
      : starting
        ? t('prompt.waitForStart', { agent: agentName })
        : (blocked?.message ?? null)
  const queueKey = sendKey === 'enter' ? 'Enter' : 'Mod+Enter'
  const steerKey = sendKey === 'enter' ? 'Mod+Enter' : 'Mod+Shift+Enter'
  // `/btw` is Kettu's own: what follows it is asked in the side chat, beside the turn, never queued.
  const sideOn = session.sideChat !== undefined
  const builtin = useMemo(() => builtinCommands(sideOn, t), [sideOn, t])
  const commands = useSlashCommands(hostId, builtin, session.commands)
  const askBeside = (): boolean => {
    if (!sideOn) return false
    const question = sideQuestionOf(box.editor.current?.text() ?? box.source.text)
    if (question === null) return false
    if (attachments.length > 0) {
      setError(t('attachments.sideNoAttachments'))
      return true
    }
    const taken = box.take()
    openSideChat(sessionId)
    if (question !== '') {
      askSide(sessionId, question, null).catch((reason: unknown) => box.restore(taken)(reason))
    }
    return true
  }
  const add = useAddMenu({
    box,
    agentName,
    commands,
    ...(sideOn ? { onSideChat: () => openSideChat(sessionId) } : {}),
  })

  // An agent that is gone takes no settings; the one picked to carry on shows its own.
  const config = pendingConfig ?? (mustSwitch ? [] : session.config)
  const mode = config.find((o): o is SelectOption => o.category === 'mode' && isSelect(o))
  const model = config.find((o): o is SelectOption => o.category === 'model' && isSelect(o))
  const effort = config.find((o) => o.category === 'thought_level' && isSelect(o))
  // A used-up window of another model does not hold this session back.
  const modelLimits = limitsForModel(limits ?? [], model)
  const reached = modelLimits.find((l) => l.state === 'reached')
  // The host carries the session on by itself once the window that stopped it resets.
  const continuesAt = useSessionsStore((s) => {
    const turn = s.byId[sessionId]?.lastTurn
    return turn?.reason === 'limit' ? turn.continuesAt : undefined
  })
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
    // A phone raises its keyboard only when the box is tapped.
    if (!focused || starting || phone) return
    if (document.activeElement === document.body) box.editor.current?.focus()
  }, [starting, ready, focused, box.editor, phone])

  // Both go through the host's queue, which sends at once when the session is free; a message
  // that hands the session to another agent goes as that agent's first turn.
  const send = (now = { canSend, canQueue }) => {
    if (askBeside()) return
    if (pending && now.canSend) handOver()
    else if (now.canSend || now.canQueue) queue(false, now.canSend)
  }
  const blockedEnter = useBlockedEnter({
    reason: unsendable,
    waiting: unsendable !== null && unsendable === blocked?.message && blocked.adding,
    source: box.source,
    attachments,
    send: () => send(live()),
  })

  // The comments stay in the composer until the message is sent, and with it when it fails.
  const takeContent = () => {
    const taken = box.take()
    const comments = commentsOf(sessionId)
    keepComments(sessionId)
    const sent = selection && taken.prompt.trim() ? selection : null
    const prompt = sent ? selectionPrompt(taken.prompt, sent) : taken.prompt
    if (sent) setPaneSelection(null)
    const text = commentsMessage(comments, prompt)
    // How the message reads in the queue: the count, then the text or else the first comment.
    const summary =
      comments.length > 0
        ? {
            count: comments.length,
            text: (taken.prompt.trim() || comments[0]!.comment).slice(0, QUEUED_COMMENTS_TEXT),
          }
        : null
    const content: UserContent[] = [
      ...(text.trim() ? [{ type: 'text' as const, text }] : []),
      ...attachmentContent(taken.held),
      // A terminal, tab or device the text mentions goes with it, which lets the agent use it.
      ...surfaceRefs(prompt, mentionResolver([], null, mentionSurfacesOf(sessionId))).map(
        (ref) => ({
          type: 'ref' as const,
          ref,
        }),
      ),
      // An item of a plugin the text mentions goes with it, and its content is read as it is sent.
      ...pluginRefs(prompt, mentionResolver([], null, NO_SURFACES, taken.mentions)).map((ref) => ({
        type: 'ref' as const,
        ref: { kind: 'plugin' as const, ...ref },
      })),
    ]
    const commentIds = comments.map((c) => c.id)
    return { taken, sent, content, commentIds, summary }
  }

  // The background work the session's agent would stop by switching, while the user is asked.
  const [switchWork, setSwitchWork] = useState<WorkItem[] | null>(null)
  const checkingSwitch = useRef(false)
  const handOver = () => {
    if (!pending || checkingSwitch.current) return
    checkingSwitch.current = true
    void runningWorkOf([sessionId]).then((work) => {
      checkingSwitch.current = false
      // A turn or a request in wait already keeps the message from going; sub-sessions go on.
      const items = work
        .filter((item) => item.sessionId === sessionId)
        .flatMap((item) => workItems(item, true))
      if (items.length > 0) setSwitchWork(items)
      else switchNow()
    })
  }

  // Reads the pending switch again: the user may have changed it while the work was read.
  const switchNow = () => {
    const now = useAgentSwitchStore.getState().pending[sessionId]
    if (!now) return
    const { taken, sent, content, commentIds } = takeContent()
    const options = Object.keys(now.values).length > 0 ? { options: now.values } : {}
    host('sessions.switchAgent', {
      sessionId,
      agentId: now.agentId,
      content,
      ...options,
      ...(now.summarize ? { summarize: true } : {}),
    })
      .then(() => {
        setPendingSwitch(sessionId, null)
        removeComments(sessionId, commentIds)
      })
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

  /** With `shown`, the session is free, so the message shows in the thread as it goes. */
  const queue = (steer: boolean, shown = false) => {
    const { taken, sent, content, commentIds, summary } = takeContent()
    const unshow = shown ? showSending(sessionId, content) : null
    host('sessions.queue', { sessionId, content, ...(summary ? { comments: summary } : {}) })
      .then(({ itemId }) => {
        removeComments(sessionId, commentIds)
        // It waits in the queue after all, which shows it there.
        if (itemId) unshow?.()
        // Once queued, a failed steer leaves the message in the queue, not lost.
        if (steer && itemId) {
          host('sessions.steer', { sessionId, itemId }).catch((e: unknown) =>
            setError(errorMessage(e)),
          )
        }
      })
      .catch((reason: unknown) => {
        unshow?.()
        if (sent) setPaneSelection(sent)
        box.restore(taken)(reason)
      })
  }

  const cancel = () => {
    host('sessions.cancel', { sessionId }).catch((e: unknown) => setError(errorMessage(e)))
  }

  // Add and send in the selection box sends what this composer holds, the new comment included.
  const paneId = usePane()?.paneId ?? null
  const sendFromReply = useEffectEvent(() => {
    const now = live()
    if (now.canSend || now.canQueue) send(now)
  })
  useEffect(
    () =>
      onAppEvent((event) => {
        if (event.kind !== 'send-composer' || event.sessionId !== sessionId) return
        if (event.paneId === null || event.paneId === paneId) sendFromReply()
      }),
    [sessionId, paneId],
  )

  // A step asked for and not yet reported, so quick presses keep stepping from it.
  const stepped = useRef<Record<string, { from: string | undefined; to: string }>>({})
  // Shift+Tab steps through the permission modes and Alt+E through the effort levels.
  const cycle = (category: 'mode' | 'thought_level') => {
    const option = config.find((o) => o.category === category && o.type === 'select')
    if (!option?.choices?.length) return false
    const reported = option.value === undefined ? undefined : String(option.value)
    const asked = stepped.current[option.id]
    const current = asked && asked.from === reported ? asked.to : reported
    const levels = category === 'mode' ? null : dialStops(option as SelectOption, current)
    const next = levels ? nextChoice(levels.stops, levels.shown) : nextMode(option.choices, current)
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
        if (!live().holds) pressWaitingCard(sessionId, 'escape')
      } else cancel()
      return
    }
    if (event.key !== 'Enter') return
    const now = live()
    // With nothing written, Enter and Mod+Enter answer the waiting card, as its buttons show.
    const cardKey = isMod(event) ? 'confirm' : event.metaKey || event.ctrlKey ? null : 'enter'
    if (
      !now.holds &&
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
    if ((sends || steers) && askBeside()) {
      event.preventDefault()
      return
    }
    if (steers) {
      event.preventDefault()
      if (now.canQueue) queue(true)
      return
    }
    if (!sends) return
    event.preventDefault()
    if (now.canSend || now.canQueue) send(now)
    else if (now.holds) blockedEnter.enter()
  }

  // The idle line, which the agent's guess at the next message takes the place of.
  const idleLine = t('prompt.placeholder.ask')
  const placeholder = starting
    ? t('prompt.placeholder.starting', { agent: agentName })
    : mustSwitch && !pending
      ? t('prompt.placeholder.pickAgent')
      : awaiting
        ? t(asked ? 'prompt.placeholder.awaitingAnswer' : 'prompt.placeholder.awaiting')
        : !running && reached?.resetsAt
          ? t(
              reached.extraUsage
                ? 'prompt.placeholder.limitExtraUsage'
                : typeof continuesAt === 'number'
                  ? 'prompt.placeholder.limitReachedContinue'
                  : 'prompt.placeholder.limitReached',
              {
                limit: limitPhrase(reached),
                time: resetTime(typeof continuesAt === 'number' ? continuesAt : reached.resetsAt),
              },
            )
          : !running && rejected
            ? t('prompt.placeholder.denied')
            : running
              ? t(phone ? 'prompt.placeholder.runningTouch' : 'prompt.placeholder.runningQueue')
              : taskRunning
                ? t('prompt.placeholder.taskRunning')
                : idleLine
  // A phone has no Tab to take it with.
  const suggestion =
    placeholder === idleLine && idle && !phone ? (session.suggestion ?? null) : null

  const cache = cacheExpiry(session, agent?.account ?? null)
  const timed = cache?.expiresAt != null ? cache : null
  const cachePhase = useCachePhase(knownExpiry(cache))
  // The cache write the notice was closed for, so it stays closed until the next one expires.
  const [noticeClosedFor, setNoticeClosedFor] = useState<number | null>(null)
  const reread = session.usage?.used ?? 0
  const cacheNoticeShown =
    timed !== null &&
    cachePhase === 'expired' &&
    holdsMessage &&
    !running &&
    !starting &&
    pending === null &&
    !mustSwitch &&
    reread >= CACHE_NOTICE_MIN_TOKENS &&
    noticeClosedFor !== timed.lastRequestAt
  const modelName = model
    ? (shownChoice(model.choices, String(model.value))?.name ?? String(model.value))
    : null
  // While a turn runs, Stop shows with nothing written and Send, which queues, once a message is.
  const sendControl =
    running && !holdsMessage ? (
      <StopButton onStop={cancel} />
    ) : running && canQueue ? (
      <QueueButton
        steering={steering}
        queueKey={queueKey}
        steerKey={steerKey}
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
      <SendButton key="send" disabled={!canSend} label={t('prompt.send')} onClick={() => send()} />
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
      <AnimatePresence initial={false}>
        {cacheNoticeShown && (
          <CacheNotice
            key="cache-notice"
            estimate={timed.estimate}
            used={reread}
            onDismiss={() => setNoticeClosedFor(timed.lastRequestAt)}
          />
        )}
      </AnimatePresence>
      <ChatComposer
        field={
          <PromptBox
            box={box}
            agentId={session.agentId}
            hostId={hostId}
            agentName={agentName}
            commands={commands}
            placeholder={placeholder}
            suggestion={suggestion}
            label={t('prompt.label', { agent: agentName })}
            size={{
              minHeight: 'calc(2 * var(--prose-size) + 14px)',
              padding: '0',
              lineHeight: 'calc(var(--prose-size) + 7px)',
            }}
            onKeyDown={onKeyDown}
            top={
              <>
                {box.historyPosition ? (
                  <HistoryHeader position={box.historyPosition} />
                ) : (
                  session.rewound && (
                    <RewoundHeader sessionId={sessionId} turns={session.rewound.turns} />
                  )
                )}
                <CommentList sessionId={sessionId} />
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
                  {heldOutside && <HeldStrip key="held" />}
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
        addRequest={box.addRequest}
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
              harness={agent?.harnessName ?? agentName}
              config={config}
              running={running}
              onSelect={set}
              open={modelMenuOpen}
              onOpenChange={setModelMenuOpen}
              outOfCredit={!!outOfCredit}
              source={agent?.version ? `${agent.harnessName} ${agent.version}` : null}
              onSwitchAgent={() => setChoosingAgent(true)}
              canSwitchAgent={idle}
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
              <BranchTrayLink projectPath={folder} sessionId={sessionId} />
            </span>
            {shownError && (
              <p className="kettu-tray__error" role="alert" title={shownError}>
                {shownError}
              </p>
            )}
            <span className="kettu-tray__group kettu-tray__group--end">
              <SpeedButton speed={session.speed} />
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
                  estimates={agent?.capabilities.contextEstimates}
                  usage={session.usage}
                  context={session.context}
                  limits={limits ?? []}
                  holding={modelLimits}
                  account={agent?.account ?? null}
                  model={modelName}
                />
              </AgentMarkHost.Provider>
            </span>
          </div>
        }
      />
      <SwitchConfirm
        items={switchWork}
        agentName={agentName}
        currentName={ownName}
        onAnswer={(go) => {
          setSwitchWork(null)
          if (go) switchNow()
        }}
      />
    </div>
  )
}
