import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  Cancel01Icon,
  Copy01Icon,
  Delete02Icon,
  File01Icon,
  QuoteDownIcon,
  Search01Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { AgentId, SideChatEntry, SideChatSaw, SideChatView } from '@shared/thread'
import type { SideChatAgent } from '@shared/agent-host'
import { emitAppEvent } from '@renderer/app/events'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Textarea } from '@renderer/components/ui/textarea'
import { toast } from '@renderer/components/ui/toast'
import { Markdown } from '@renderer/features/session/markdown'
import { SendButton } from '@renderer/features/session/composer/send-button'
import { TurnDots } from '@renderer/features/session/turn-dots'
import { PaneBody, PaneContext, PaneIcon, PanelButton } from '@renderer/features/shell/panel-button'
import { errorMessage, host } from '@renderer/lib/host'
import { formatShortcut, isMod } from '@renderer/lib/platform'
import { agentName } from '@renderer/stores/agents'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import { askSide, setSideDraft, useSideChatStore } from '@renderer/stores/side-chat'
import { useThreadsStore } from '@renderer/stores/threads'
import './side-chat.css'

const NO_DRAFT = { text: '', quote: null }
// An answer this close to the bottom keeps the column following it as it grows.
const FOLLOW_PX = 80

interface Props {
  sessionId: string
  agentId: AgentId
  hostId: string | null
}

/** What the session's Side chat tab shows in the side panel. */
export default function SideChatPane({ sessionId }: { sessionId: string }) {
  const summary = useSessionsStore((s) => s.byId[sessionId])
  if (!summary) return null
  return (
    <SideChat sessionId={sessionId} agentId={summary.agentId} hostId={hostOfSession(summary)} />
  )
}

/**
 * The session's side chat: questions asked beside the session, answered from its conversation
 * and never part of it. It says how its agent answers and what that costs, since the ways differ.
 */
function SideChat({ sessionId, agentId, hostId }: Props) {
  const { t } = useTranslation('session')
  const side = useThreadsStore((s) => s.replicas[sessionId]?.state?.session.sideChat ?? null)
  const draft = useSideChatStore((s) => s.drafts[sessionId] ?? NO_DRAFT)
  const focusAsked = useSideChatStore((s) => s.focus[sessionId] ?? 0)
  const sendKey = useSettingsStore((s) => s.settings.general.sendKey)
  const input = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  // For a session whose agent cannot answer: the one picked here, before the first question.
  const [picked, setPicked] = useState<AgentId | null>(null)
  const [picking, setPicking] = useState(false)

  const entries = side?.entries ?? []
  const answering = entries.some((entry) => entry.status === 'answering')
  const route = side?.route ?? 'none'
  const answerAgent = route === 'none' ? (picked ?? side?.answerAgent ?? null) : null
  const needsPick = route === 'none' && (side?.answerAgent === null || picking)
  const name = agentName(agentId, hostId)

  useEffect(() => {
    if (focusAsked > 0) input.current?.focus()
  }, [focusAsked])

  // Follows the newest answer while the reader is at the bottom, and always to a new question.
  const count = entries.length
  const last = entries[entries.length - 1]
  const lastLength = last?.answer.length ?? 0
  // From 0, so the column opens at its newest answer.
  const lastCount = useRef(0)
  useLayoutEffect(() => {
    const box = scroller.current
    if (!box) return
    const added = count > lastCount.current
    lastCount.current = count
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < FOLLOW_PX
    if (added || near) box.scrollTop = box.scrollHeight
  }, [count, lastLength, last?.status])

  const ask = (question: string, quote: string | null) => {
    if (sending || answering || !question.trim()) return
    if (needsPick && !answerAgent) return
    setSending(true)
    setError(null)
    askSide(
      sessionId,
      question.trim(),
      quote,
      route === 'none' ? (answerAgent ?? undefined) : undefined,
    )
      .then(() => {
        setSideDraft(sessionId, { text: '', quote: null })
        setPicking(false)
      })
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setSending(false))
  }

  const back = () => emitAppEvent({ kind: 'focus-composer' })

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      // Esc here leaves the side chat; it never reaches the composer, where it stops the turn.
      event.preventDefault()
      event.stopPropagation()
      back()
      return
    }
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return
    const sends = sendKey === 'enter' ? !event.shiftKey : isMod(event)
    if (!sends) return
    event.preventDefault()
    ask(draft.text, draft.quote)
  }

  const clear = () => {
    host('sessions.sideClear', { sessionId })
      .then(() =>
        toast(t('sideChat.cleared'), {
          label: t('sideChat.undo'),
          onClick: () => void host('sessions.sideClear', { sessionId, undo: true }).catch(() => {}),
        }),
      )
      .catch((reason: unknown) => setError(errorMessage(reason)))
  }

  const note =
    route === 'none'
      ? side?.answerAgent
        ? t('sideChat.note.other', { agent: agentName(side.answerAgent, hostId) })
        : ''
      : t(`sideChat.note.${route}`)

  return (
    <PaneBody className="kc-rail" aria-label={t('sideChat.title')}>
      <PaneContext
        tools={
          <PanelButton label={t('sideChat.clear')} disabled={entries.length === 0} onClick={clear}>
            <PaneIcon icon={Delete02Icon} />
          </PanelButton>
        }
      >
        <span className="kp-ctx__place" title={note}>
          <span>{note}</span>
        </span>
      </PaneContext>
      <div ref={scroller} className="kc-scroll">
        {needsPick ? (
          <PickAgent
            sessionId={sessionId}
            agentId={agentId}
            hostId={hostId}
            picked={answerAgent}
            onPick={setPicked}
          />
        ) : entries.length === 0 ? (
          <EmptySide side={side} agentId={answerAgent ?? agentId} hostId={hostId} own={name} />
        ) : (
          <div className="kc-list" aria-live="polite">
            {entries.map((entry) => (
              <SideEntry
                key={entry.id}
                sessionId={sessionId}
                entry={entry}
                hostId={hostId}
                ownAgent={agentId}
                onRetry={() => ask(entry.question, entry.quote)}
                canRetry={!answering && !sending}
              />
            ))}
          </div>
        )}
        {route === 'none' && side?.answerAgent && !picking && entries.length === 0 && (
          <button type="button" className="kc-link" onClick={() => setPicking(true)}>
            {t('sideChat.pick.change')}
          </button>
        )}
      </div>
      <div className="kc-foot">
        <div className="kc-box">
          {draft.quote && (
            <div className="kc-box__quote">
              <blockquote aria-label={t('sideChat.quoted')}>{draft.quote}</blockquote>
              <button
                type="button"
                className="kp-tool"
                aria-label={t('sideChat.removeQuote')}
                onClick={() => setSideDraft(sessionId, { quote: null })}
              >
                <PaneIcon icon={Cancel01Icon} size={13} />
              </button>
            </div>
          )}
          <div className="kc-box__row">
            <Textarea
              ref={input}
              rows={1}
              value={draft.text}
              placeholder={
                entries.length > 0
                  ? t('sideChat.placeholder.more')
                  : t('sideChat.placeholder.first')
              }
              aria-label={t('sideChat.title')}
              onChange={(event) => setSideDraft(sessionId, { text: event.target.value })}
              onKeyDown={onKeyDown}
              className="kc-box__input"
            />
            <SendButton
              disabled={!draft.text.trim() || sending || answering || (needsPick && !answerAgent)}
              label={
                needsPick && answerAgent
                  ? t('sideChat.pick.ask', { agent: agentName(answerAgent, hostId) })
                  : t('sideChat.send')
              }
              onClick={() => ask(draft.text, draft.quote)}
            />
          </div>
        </div>
        {error && (
          <p role="alert" className="kc-error">
            {error}
          </p>
        )}
        <div className="kc-hint">
          <span>
            {t('sideChat.hint.keys', {
              send: sendKey === 'enter' ? 'Enter' : formatShortcut('Mod+Enter'),
            })}
          </span>
          <span>{t('sideChat.hint.close', { keys: formatShortcut('Mod+J') })}</span>
        </div>
      </div>
    </PaneBody>
  )
}

/** What a side question here sees, whether it uses tools and what it costs, by how it is answered. */
function EmptySide({
  side,
  agentId,
  hostId,
  own,
}: {
  side: SideChatView | null
  agentId: AgentId
  hostId: string | null
  own: string
}) {
  const { t } = useTranslation('session')
  const route = side?.route ?? 'none'
  const lines =
    route === 'claude'
      ? ['claudeSees', 'noInterrupt', 'claudeTools', 'claudeCost']
      : route === 'codex'
        ? ['codexSees', 'noInterrupt', 'codexTools', 'codexCost']
        : route === 'fork'
          ? ['forkHow', 'forkSees', 'forkCost', 'noInterrupt']
          : ['hiddenHow', 'hiddenCarried', 'hiddenCost', 'noInterrupt']
  const name = agentName(agentId, hostId)
  return (
    <div className="kc-empty">
      <h3 className="kc-empty__title">
        <AgentMark agent={agentId} hostId={hostId} size={16} />
        {t('sideChat.empty.title', { agent: name })}
      </h3>
      <ul className="kc-empty__lines">
        {lines.map((line) => (
          <li key={line}>
            {t(`sideChat.empty.${line}` as 'sideChat.empty.noInterrupt', {
              agent: route === 'none' ? own : name,
            })}
          </li>
        ))}
      </ul>
      {route === 'none' && <p className="kc-empty__by">{t('sideChat.by', { agent: name })}</p>}
    </div>
  )
}

/** For a session whose agent cannot answer: which agent of this host answers instead. */
function PickAgent({
  sessionId,
  agentId,
  hostId,
  picked,
  onPick,
}: {
  sessionId: string
  agentId: AgentId
  hostId: string | null
  picked: AgentId | null
  onPick: (agentId: AgentId) => void
}) {
  const { t } = useTranslation('session')
  const [agents, setAgents] = useState<SideChatAgent[] | null>(null)
  useEffect(() => {
    let live = true
    host('sessions.sideAgents', { sessionId })
      .then(({ agents: list }) => {
        if (!live) return
        setAgents(list)
        if (!picked && list[0]) onPick(list[0].agentId)
      })
      .catch(() => live && setAgents([]))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per session
  }, [sessionId])
  const own = agentName(agentId, hostId)
  return (
    <div className="kc-empty">
      <h3 className="kc-empty__title">
        <AgentMark agent={agentId} hostId={hostId} size={16} />
        {t('sideChat.pick.title', { agent: own })}
      </h3>
      <p className="kc-empty__text">{t('sideChat.pick.why')}</p>
      {agents !== null && agents.length === 0 ? (
        <p className="kc-empty__text">{t('sideChat.pick.none')}</p>
      ) : (
        <div className="kc-pick">
          <div className="kc-pick__row">
            <span>{t('sideChat.pick.before')}</span>
            <Select
              value={picked}
              items={(agents ?? []).map((agent) => ({ value: agent.agentId, label: agent.name }))}
              onValueChange={(next) => {
                if (next) onPick(next)
              }}
            >
              <SelectTrigger className="kc-pick__select" aria-label={t('sideChat.pick.before')}>
                <SelectValue>
                  {(current: AgentId | null) =>
                    current ? (
                      <span className="flex items-center gap-1.5">
                        <AgentMark agent={current} hostId={hostId} size={14} />
                        {agentName(current, hostId)}
                      </span>
                    ) : null
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(agents ?? []).map((agent) => (
                  <SelectItem key={agent.agentId} value={agent.agentId}>
                    <span className="flex items-center gap-1.5">
                      <AgentMark agent={agent.agentId} hostId={hostId} size={14} />
                      {agent.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {t('sideChat.pick.after') && <span>{t('sideChat.pick.after')}</span>}
          </div>
          {picked && (
            <p className="kc-pick__cost">
              {t('sideChat.pick.cost', { agent: agentName(picked, hostId) })}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

const STEP_ICONS = { read: File01Icon, search: Search01Icon, run: File01Icon, other: File01Icon }

function SideEntry({
  sessionId,
  entry,
  hostId,
  ownAgent,
  onRetry,
  canRetry,
}: {
  sessionId: string
  entry: SideChatEntry
  hostId: string | null
  ownAgent: AgentId
  onRetry: () => void
  canRetry: boolean
}) {
  const { t } = useTranslation('session')
  const [copied, setCopied] = useState(false)
  const waiting = entry.status === 'answering'
  const seconds =
    entry.answeredAt !== null ? Math.max(0.1, (entry.answeredAt - entry.askedAt) / 1000) : null
  const step = entry.steps[0]
  const saw = entry.saw
  const sawLabel = (seen: SideChatSaw): string => {
    const compacted = seen.compacted > 0
    if (seen.source === 'agent') {
      return t(compacted ? 'sideChat.saw.agentCompacted' : 'sideChat.saw.agent', {
        agent: agentName(ownAgent, hostId),
      })
    }
    if (seen.source === 'fork') {
      return t(compacted ? 'sideChat.saw.forkCompacted' : 'sideChat.saw.fork')
    }
    const copy = seen.copy
    if (!copy || copy.turns === 0) {
      return t(compacted ? 'sideChat.saw.compactedNone' : 'sideChat.saw.none')
    }
    const tokens = Math.max(1, Math.round(copy.bytes / 1000))
    if (copy.first) {
      return t('sideChat.saw.copyPart', { count: copy.turns, total: copy.total, tokens })
    }
    return t(compacted ? 'sideChat.saw.copyAfter' : 'sideChat.saw.copyAll', {
      count: copy.turns,
      tokens,
    })
  }

  const copy = () => {
    void navigator.clipboard.writeText(entry.answer).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  const quote = () => {
    const quoted = entry.answer
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')
    emitAppEvent({ kind: 'insert-into-composer', sessionId, text: `${quoted}\n\n` })
  }

  return (
    <section className="kc-entry">
      <div className="kc-q">
        {entry.quote && <blockquote className="kc-q__quote">{entry.quote}</blockquote>}
        <p className="kc-q__text">{entry.question}</p>
      </div>
      {entry.agentId !== ownAgent && (
        <p className="kc-meta">
          <AgentMark agent={entry.agentId} hostId={hostId} size={12} />
          {t('sideChat.by', { agent: agentName(entry.agentId, hostId) })}
        </p>
      )}
      {step && (
        <p className="kc-meta" title={entry.steps.map((s) => s.title).join('\n')}>
          <PaneIcon icon={STEP_ICONS[step.kind]} size={12} />
          <span className="truncate">
            {entry.steps.map((s) => t(`sideChat.step.${s.kind}`, { title: s.title })).join(' · ')}
          </span>
        </p>
      )}
      {saw && (entry.status !== 'failed' || saw.source === 'copy') && (
        <p className="kc-meta">
          <PaneIcon icon={File01Icon} size={12} />
          {sawLabel(saw)}
        </p>
      )}
      {saw && saw.compacted > 0 && saw.copy?.turns !== 0 && (
        <p className="kc-meta">
          <PaneIcon icon={File01Icon} size={12} />
          {t('sideChat.saw.compacted', { count: saw.compacted })}
        </p>
      )}
      {saw?.fellBackFrom && (
        <p className="kc-meta">
          <PaneIcon icon={File01Icon} size={12} />
          {t(
            saw.fellBackFrom === 'claude'
              ? 'sideChat.saw.fellBackAgent'
              : 'sideChat.saw.fellBackFork',
            {
              agent: agentName(ownAgent, hostId),
            },
          )}
        </p>
      )}
      {entry.answer !== '' && (
        <div className="kc-a">
          <Markdown markdown={entry.answer} streaming={waiting} />
        </div>
      )}
      {waiting && (
        <div className="kc-wait">
          {entry.answer === '' && (
            <>
              <TurnDots phase="thinking" className="kc-dots" />
              <span>{t('sideChat.answering')}</span>
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="kc-stop"
            onClick={() => void host('sessions.sideStop', { sessionId }).catch(() => {})}
          >
            <i aria-hidden className="kc-stop__mark" />
            {t('sideChat.stop')}
          </Button>
        </div>
      )}
      {entry.status === 'failed' && (
        <div className="kc-fail" role="alert">
          <span>{entry.error}</span>
          <button type="button" className="kc-link" disabled={!canRetry} onClick={onRetry}>
            {t('sideChat.retry')}
          </button>
        </div>
      )}
      {entry.status === 'stopped' && (
        <div className="kc-acts">
          <span className="kc-acts__time">{t('sideChat.stopped')}</span>
          <button type="button" className="kc-link" disabled={!canRetry} onClick={onRetry}>
            {t('sideChat.retry')}
          </button>
        </div>
      )}
      {entry.status === 'answered' && (
        <div className="kc-acts">
          <button type="button" className="kc-act" onClick={quote}>
            <PaneIcon icon={QuoteDownIcon} size={13} />
            {t('sideChat.quote')}
          </button>
          <button type="button" className="kc-act" onClick={copy}>
            <PaneIcon icon={Copy01Icon} size={13} />
            {copied ? t('sideChat.copied') : t('sideChat.copy')}
          </button>
          {seconds !== null && (
            <span className="kc-acts__time">
              {t('sideChat.seconds', {
                n: seconds < 10 ? seconds.toFixed(1) : Math.round(seconds),
              })}
            </span>
          )}
        </div>
      )}
    </section>
  )
}
