import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ThreadEntry } from '@shared/thread'
import { ToolCallCard, type ToolCallLabels } from '@renderer/components/affect/tool-call-card'
import { cn } from '@renderer/lib/utils'
import { isFresh } from '@renderer/stores/threads'
import { Markdown } from '../markdown'
import { thoughtTitle, toolLabel } from './helpers'
import { entryPictures } from './row-pictures'
import { RowThumbs } from './row-thumbs'
import { ThoughtBody, ToolBody, ToolSummary } from './tool-call-parts'
import { toolHasBody, type StepFacts } from './tool-call-model'
import { useOpenedOnce } from './use-opened'

const COMPACTION_KEY = {
  in_progress: 'inProgress',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
} as const

/**
 * Stands in for a step's card while its group is folded. The group's line reads the icon, status
 * and times off its children's props, so it needs them even when nothing is drawn.
 */
export function StepStub(props: Omit<StepFacts, 'glyph'> & { icon: ReactNode }): null {
  void props
  return null
}

/**
 * A step of the thread's work on affectUI's Tool Call Card: a tool call, a thought or a
 * compaction. Its facts come as props of their own (tool-call-model.ts), which a group reads.
 * `note` follows a tool call's target; a call a routine allowed says so by default. Its content
 * renders once the card first opens; until then the body is null, since false would leave the card
 * without one.
 */
export function StepCard({
  sessionId,
  entry,
  projectPath,
  labels,
  note,
  status,
  startedAt,
  duration,
  time,
  icon,
  defaultOpen = false,
}: Omit<StepFacts, 'glyph'> & {
  sessionId: string
  entry: ThreadEntry
  projectPath: string
  labels: Partial<ToolCallLabels>
  note?: string
  icon: ReactNode
  /** Opens it from the start, as a call waiting for permission does. */
  defaultOpen?: boolean
}) {
  const { t } = useTranslation('session')
  // A step that arrived while shown draws its part of a run's timeline in (session.css).
  const [fresh] = useState(() => isFresh(sessionId, entry.id))
  const [opened, onOpenChange, opening] = useOpenedOnce(status, defaultOpen)
  const facts = {
    status,
    startedAt,
    duration,
    time,
    icon,
    labels,
    chevron: 'after' as const,
    defaultOpen,
    className: cn(fresh && 'ks-step-new', opening && 'ks-step-opening') || undefined,
    onOpenChange,
  }
  if (entry.kind === 'tool') {
    const label = toolLabel(entry, projectPath, entry.status === 'completed')
    const pictures = entryPictures(entry)
    const result = entry.permissionResult
    if (note === undefined && typeof result === 'object' && result?.by === 'routine') {
      note = t('permission.answer.allowedByRoutine')
    }
    return (
      <ToolCallCard
        {...facts}
        name={label.verb ?? entry.title}
        summary={
          label.verb && label.target ? (
            <ToolSummary entry={entry} target={label.target} note={note} />
          ) : (
            note
          )
        }
        trail={
          pictures.length > 0 ? <RowThumbs sessionId={sessionId} pictures={pictures} /> : undefined
        }
      >
        {toolHasBody(entry, projectPath) ? (
          opened ? (
            <ToolBody sessionId={sessionId} entryId={entry.id} projectPath={projectPath} />
          ) : null
        ) : (
          false
        )}
      </ToolCallCard>
    )
  }
  if (entry.kind === 'thought') {
    return (
      <ToolCallCard
        {...facts}
        name={t('summary.thought')}
        summary={thoughtTitle(entry.markdown) ?? undefined}
      >
        {entry.markdown.trim() ? (
          opened ? (
            <ThoughtBody sessionId={sessionId} entryId={entry.id} />
          ) : null
        ) : (
          false
        )}
      </ToolCallCard>
    )
  }
  if (entry.kind === 'compaction') {
    return (
      <ToolCallCard {...facts} name={t(`compaction.${COMPACTION_KEY[entry.status]}`)}>
        {entry.summary ? (
          opened ? (
            <div data-selectable="" className="text-muted-foreground">
              <Markdown
                markdown={entry.summary}
                streaming={entry.status === 'in_progress'}
                className="markdown-muted"
              />
            </div>
          ) : null
        ) : (
          false
        )}
      </ToolCallCard>
    )
  }
  return null
}
