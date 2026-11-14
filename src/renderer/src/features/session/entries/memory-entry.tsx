import { memo, useState } from 'react'
import { Undo02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { MemoryWriteEntry } from '@shared/thread'
import { Icon } from '@renderer/components/affect/app-shell'
import {
  ToolCallCard,
  type ToolCallCardProps,
  type ToolCallLabels,
} from '@renderer/components/affect/tool-call-card'
import { Button } from '@renderer/components/ui/button'
import { toast } from '@renderer/components/ui/toast'
import { openMemoryItem } from '@renderer/features/settings/memory-items'
import { host } from '@renderer/lib/host'
import { hostOfPath, hostPath } from '@renderer/lib/host-paths'
import { memoryErrorText, memoryRefusal } from '@renderer/lib/memory-errors'
import { cn } from '@renderer/lib/utils'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useEntry, useEntryAnimation } from '../use-thread'
import { AccessCard, type AccessDecision } from './access-card'
import { MEMORY_GLYPH, stepFacts, useToolCallLabels } from './tool-call-model'

/**
 * An agent's write to Kettu's memory: a project write as a step of the work around it, a proposed
 * global write as the permission card, which neither holds the turn nor marks the session waiting.
 */
export const MemoryEntry = memo(function MemoryEntry({
  sessionId,
  entryId,
  agentName,
}: {
  sessionId: string
  entryId: string
  agentName: string
}) {
  const entry = useEntry(sessionId, entryId, 'memory')
  const animation = useEntryAnimation(sessionId, entryId)
  const labels = useToolCallLabels()
  if (!entry) return null
  if (entry.layer === 'global') {
    return (
      <MemoryProposal
        sessionId={sessionId}
        entry={entry}
        agentName={agentName}
        className={animation}
      />
    )
  }
  // A project write the thread did not fold into a run, which a run of one would draw the same.
  const { glyph, ...facts } = stepFacts(sessionId, entry)!
  return (
    <div className={cn('min-w-0', animation)}>
      <MemoryStep
        sessionId={sessionId}
        entry={entry}
        card={{
          ...facts,
          icon: <Icon icon={glyph} size={14} />,
          labels,
          chevron: 'before',
        }}
      />
    </div>
  )
})

/** What a step's card takes from its run, beside what the write itself names. */
type StepCardProps = Pick<
  ToolCallCardProps,
  | 'status'
  | 'startedAt'
  | 'duration'
  | 'time'
  | 'icon'
  | 'chevron'
  | 'className'
  | 'shine'
  | 'onOpenChange'
> & { labels: Partial<ToolCallLabels> }

/**
 * A project memory write on its step's row: what it did and the entry's title, which opens the
 * entry in Settings, and Undo at the end while the write stands. An undone write says so where
 * the time would be; the host refuses an undo once the entry changed again, and the toast says why.
 */
export function MemoryStep({
  sessionId,
  entry,
  card,
}: {
  sessionId: string
  entry: MemoryWriteEntry
  card: StepCardProps
}) {
  const { t } = useTranslation('session')
  const projectPath = useSessionsStore((s) => s.byId[sessionId]?.projectPath ?? null)
  const [undoing, setUndoing] = useState(false)
  const undone = entry.status === 'undone'
  // The entry is there after a remember or an update that stands, or a forget taken back.
  const exists = entry.action === 'forget' ? undone : !undone
  const memoryId = entry.memoryId
  const open =
    exists && memoryId !== null && projectPath !== null
      ? () =>
          openMemoryItem(
            hostOfPath(projectPath),
            { layer: 'project', project: hostPath(projectPath) },
            memoryId,
          )
      : undefined

  const undo = async (): Promise<void> => {
    setUndoing(true)
    try {
      await host('sessions.undoMemory', { sessionId, entryId: entry.id })
    } catch (error) {
      toast(memoryErrorText(error))
    } finally {
      setUndoing(false)
    }
  }

  return (
    <ToolCallCard
      {...card}
      labels={{ ...card.labels, cancelled: t('memory.undone') }}
      name={t(`memory.action.${entry.action}`)}
      summary={entry.title}
      onActivate={open}
      trail={
        entry.status === 'written' && entry.undo !== null ? (
          <Button
            variant="quiet"
            size="xs"
            disabled={undoing}
            onClick={() => void undo()}
            aria-label={t('memory.undoLabel', { title: entry.title })}
          >
            <Icon icon={Undo02Icon} size={12} />
            {t('memory.undo')}
          </Button>
        ) : undefined
      }
    >
      {false}
    </ToolCallCard>
  )
}

/** How the card reads the proposal's answer: accepted as allowed, declined as denied. */
function shown(entry: MemoryWriteEntry): string | null {
  if (entry.status === 'proposed') return null
  return entry.status === 'declined' ? 'deny' : 'session'
}

/**
 * A proposed write to global memory, on the permission card: what the agent wants to remember
 * about the user, change or forget, with the entry's title and text; Skip and Remember. Nothing is
 * written before the user answers, and the agent carries on meanwhile.
 */
function MemoryProposal({
  sessionId,
  entry,
  agentName,
  className,
}: {
  sessionId: string
  entry: MemoryWriteEntry
  agentName: string
  className?: string
}) {
  const { t } = useTranslation('session')
  const action = entry.action
  const request = async (decision: AccessDecision): Promise<void> => {
    try {
      await host('sessions.answerMemory', {
        sessionId,
        entryId: entry.id,
        decision: decision === 'deny' ? 'skip' : 'remember',
      })
    } catch (error) {
      // The card words an answer given elsewhere itself; a refusal it shows as said here.
      const refusal = memoryRefusal(error)
      throw refusal === null ? error : new Error(refusal)
    }
  }
  return (
    <AccessCard
      sessionId={sessionId}
      entryId={entry.id}
      agentName={agentName}
      className={className}
      action={t(`memory.proposal.${action}.action`)}
      target={entry.draft?.title ?? entry.title}
      glyph={MEMORY_GLYPH}
      reason={entry.draft?.body ?? ''}
      answer={shown(entry)}
      device={entry.device}
      words={{
        allow: { session: t(`memory.proposal.${action}.allow`), always: '' },
        deny: t(`memory.proposal.${action}.deny`),
        answer: (answer) =>
          answer === 'deny'
            ? t(`memory.proposal.${action}.declined`)
            : t(`memory.proposal.${action}.accepted`),
      }}
      request={request}
      trailing={null}
    />
  )
}
