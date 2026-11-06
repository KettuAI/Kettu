import { memo, useEffect, useRef, useState } from 'react'
import { AppWindowIcon } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import type { ComputerAppAnswer, ComputerAppDecision } from '@shared/computer-use'
import type { FromDevice } from '@shared/thread'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage, host } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { cn } from '@renderer/lib/utils'
import { useOtherHost } from '@renderer/stores/hosts'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useWebHostStore } from '@renderer/stores/web-host'
import { useEntry, useEntryAnimation } from '../use-thread'
import { AnswerList, WaitingCard, WaitingHeader, WaitingStatus } from './answer-list'
import { answeredBy } from './helpers'

const DECISIONS: ComputerAppDecision[] = ['session', 'always', 'deny']

const ANSWER_TEXT = {
  session: 'computerApp.answer.session',
  always: 'computerApp.answer.always',
  deny: 'computerApp.answer.deny',
  timeout: 'computerApp.answer.timeout',
} as const satisfies Record<ComputerAppAnswer, string>

/**
 * An agent wants to read or drive a desktop app for the first time in the session: a card like a
 * new site's, with the app in its header and the three answers. Every client that shows the
 * session answers it through the host, and the first answer counts. Once answered it is a quiet
 * row, as an answered request is.
 */
export const ComputerAppEntry = memo(function ComputerAppEntry({
  sessionId,
  entryId,
  agentName,
}: {
  sessionId: string
  entryId: string
  agentName: string
}) {
  const { t } = useTranslation('session')
  const entry = useEntry(sessionId, entryId, 'computer_app')
  const animation = useEntryAnimation(sessionId, entryId)
  const [answering, setAnswering] = useState<ComputerAppDecision | null>(null)
  const [error, setError] = useState<string | null>(null)
  const card = useRef<HTMLDivElement>(null)
  const hostId = useSessionsStore((s) => hostOfPath(s.byId[sessionId]?.projectPath ?? ''))
  const other = useOtherHost(hostId)
  const served = useWebHostStore((s) => s.host?.name ?? null)
  const waiting = entry?.decision === null

  useEffect(() => {
    if (waiting) card.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [waiting])

  if (!entry) return null
  const answer = async (decision: ComputerAppDecision) => {
    setAnswering(decision)
    setError(null)
    try {
      await host('computer.answerApp', { sessionId, entryId: entry.id, decision })
    } catch (caught) {
      const by = answeredBy(caught)
      if (by !== undefined) {
        // The card takes the first answer as its patch lands, so the note goes in a toast.
        const where = by?.name ?? (hostId !== null ? (other?.name ?? null) : served)
        toast(
          where ? t('permission.answeredOn', { device: where }) : t('permission.answeredInWindow'),
        )
      } else {
        setError(errorMessage(caught))
      }
    } finally {
      setAnswering(null)
    }
  }

  if (!waiting) {
    return (
      <div
        data-entry-id={entryId}
        className={cn(
          'flex h-6.5 min-w-0 items-center gap-2 text-small text-muted-foreground',
          animation,
        )}
      >
        <AppWindowIcon aria-hidden className="size-3.5 shrink-0 text-icon" />
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="shrink-0 font-medium text-secondary">{t('computerApp.use')}</span>
          <span className="min-w-0 truncate text-secondary">{entry.appName}</span>
        </span>
        <Status decision={entry.decision} device={entry.device} />
      </div>
    )
  }

  const app = entry.appName
  return (
    <WaitingCard
      ref={card}
      entryId={entryId}
      label={t('computerApp.label')}
      description={t('computerApp.ask', { agent: agentName })}
      className={animation}
    >
      <WaitingHeader>
        <AppWindowIcon aria-hidden className="size-3.75 shrink-0" />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-ui font-medium text-secondary">
            {t('computerApp.use')}
          </span>
          <span className="min-w-0 truncate text-ui text-secondary">{app}</span>
        </span>
        <WaitingStatus>{t('computerApp.newApp')}</WaitingStatus>
      </WaitingHeader>
      <div className="flex items-center gap-3 px-3.5 pt-3 pb-1">
        <span className="flex size-8.5 shrink-0 items-center justify-center rounded-xl bg-subtle text-secondary">
          <AppWindowIcon aria-hidden className="size-4.25" />
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-row leading-normal text-foreground">
            <Trans
              t={t}
              i18nKey="computerApp.wants"
              values={{ agent: agentName, app }}
              components={{ app: <b className="font-semibold" /> }}
            />
          </span>
          <span className="truncate text-hint leading-normal text-tertiary">
            {t('computerApp.where')}
          </span>
        </div>
      </div>
      <AnswerList
        label={t('computerApp.answerGroup')}
        answers={DECISIONS.map((decision) => ({
          key: decision,
          label: t(`computerApp.decision.${decision}`, { app }),
        }))}
        primary={0}
        answering={answering}
        disabled={false}
        onAnswer={(index) => void answer(DECISIONS[index]!)}
      />
      {error && <p className="mx-3.5 mb-2.5 text-xs text-danger">{error}</p>}
    </WaitingCard>
  )
})

function Status({
  decision,
  device,
}: {
  decision: ComputerAppAnswer | null
  device: FromDevice | undefined
}) {
  const { t } = useTranslation('session')
  if (decision === null) return null
  const answer = t(ANSWER_TEXT[decision])
  return (
    <span className="shrink-0 animate-in text-xs text-tertiary animation-duration-(--duration-base) fade-in">
      {device ? t('permission.answer.onDevice', { answer, device: device.name }) : answer}
    </span>
  )
}
