import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ThreadEntry } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import {
  DecisionCard,
  type Decision,
  type DecisionAnswer,
  type DecisionCardLabels,
} from '@renderer/components/affect/decision-card'
import { host } from '@renderer/lib/host'
import { useAnswering } from '../entries/use-answering'
import {
  accessAsk,
  browserOriginAsk,
  computerAppAsk,
  deviceAccessAsk,
  projectMcpAsk,
} from './access'
import { useWaiting, type Ask, type AskContext } from './ask'
import { elicitationAsk } from './elicitation'
import { permissionAsk, useRoutineScope } from './permission'
import { planAsk } from './plan'
import { optionQuestionAsk, questionAsks } from './questions'

function asksOf(entry: ThreadEntry, ctx: AskContext, routineScope: string | null): Ask[] {
  const { t, sessionId } = ctx
  switch (entry.kind) {
    case 'tool': {
      const permission = entry.permission!
      if (permission.plan) return [planAsk(entry, ctx)]
      if (permission.elicitation) return [elicitationAsk(entry, ctx)]
      if (permission.questions) return questionAsks(entry, ctx)
      if (entry.question !== undefined) return [optionQuestionAsk(entry, ctx)]
      return [permissionAsk(entry, ctx, routineScope)]
    }
    case 'browser_origin':
      return [accessAsk(entry.id, browserOriginAsk(t, sessionId, entry), ctx)]
    case 'computer_app':
      return [accessAsk(entry.id, computerAppAsk(t, sessionId, entry), ctx)]
    case 'device_access':
      return [accessAsk(entry.id, deviceAccessAsk(t, sessionId, entry), ctx)]
    case 'project_mcp':
      return [accessAsk(entry.id, projectMcpAsk(t, sessionId, entry), ctx)]
    default:
      return []
  }
}

/**
 * Everything in the session that waits for the user's answer, on affectUI's Decision Card just
 * above the composer: one page each, oldest first. An answer that does not go brings its page
 * back with the reason over the card.
 */
export function DecisionTray({
  sessionId,
  agentName,
  projectPath,
}: {
  sessionId: string
  agentName: string
  projectPath: string
}) {
  const { t } = useTranslation('session')
  const waiting = useWaiting(sessionId)
  const routineScope = useRoutineScope(sessionId)
  const { error, send } = useAnswering(sessionId)
  // Raised for a group whose answer did not go, so its pages come back as new ones.
  const [attempts, setAttempts] = useState<Record<string, number>>({})
  const [scratch, setScratch] = useState<Record<string, unknown>>({})
  const [reveal, setReveal] = useState(0)
  const root = useRef<HTMLDivElement>(null)

  const ctx: AskContext = {
    t,
    sessionId,
    agentName,
    projectPath,
    go: async (group, request) => {
      const sent = await send(group, request)
      if (!sent) setAttempts((a) => ({ ...a, [group]: (a[group] ?? 0) + 1 }))
      return sent
    },
    say: async (text) => {
      await host('sessions.queue', { sessionId, content: [{ type: 'text', text }] })
    },
    state: <T,>(key: string, initial: T): [T, (next: T) => void] => [
      key in scratch ? (scratch[key] as T) : initial,
      (next) => setScratch((s) => ({ ...s, [key]: next })),
    ],
  }
  const asks = waiting.flatMap((entry) => asksOf(entry, ctx, routineScope))
  const decisions: Decision[] = asks.map((ask) => ({
    ...ask.decision,
    id: `${ask.key}#${attempts[ask.group] ?? 0}`,
  }))

  const labels = useMemo<Partial<DecisionCardLabels>>(
    () => ({
      needsYou: t('decision.needsYou'),
      later: t('decision.later'),
      show: t('decision.show'),
      recommended: t('decision.recommended'),
      approve: t('decision.approve'),
      decline: t('decision.decline'),
      own: t('decision.own'),
      send: t('decision.send'),
      answered: t('decision.answered'),
      previous: t('decision.previous'),
      next: t('decision.next'),
      allDone: t('decision.allDone'),
      waiting: (count) => t('decision.waiting', { count }),
      of: (index, count) => t('decision.of', { index, count }),
    }),
    [t],
  )

  // A new request takes the focus only when nothing else has it, so typing never answers one.
  const count = decisions.length
  const seen = useRef(0)
  useEffect(() => {
    const grew = count > seen.current
    seen.current = count
    const active = document.activeElement
    if (grew && (!active || active === document.body)) setReveal((r) => r + 1)
  }, [count])

  const onDecide = (id: string, answer: DecisionAnswer) => {
    const ask = asks.find((_, i) => decisions[i]!.id === id)
    if (!ask) return
    // After the last answer the card folds away, so the focus goes on to the composer.
    if (decisions.length === 1 && root.current?.contains(document.activeElement)) {
      emitAppEvent({ kind: 'focus-composer' })
    }
    ask.answer(answer)
  }

  return (
    <div ref={root} className="ks-decisions">
      {error && count > 0 && (
        <p role="alert" className="ks-card-error">
          {error}
        </p>
      )}
      <DecisionCard decisions={decisions} onDecide={onDecide} reveal={reveal} labels={labels} />
    </div>
  )
}
