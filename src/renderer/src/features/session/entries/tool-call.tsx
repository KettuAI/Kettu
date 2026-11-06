import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ThreadEntry } from '@shared/thread'
import { ToolCallCard, type ToolCallLabels } from '@renderer/components/affect/tool-call-card'
import { Markdown } from '../markdown'
import { thoughtTitle, toolLabel } from './helpers'
import { entryPictures } from './row-pictures'
import { RowThumbs } from './row-thumbs'
import { ThoughtBody, ToolBody, ToolSummary } from './tool-call-parts'
import { toolHasBody, type StepFacts } from './tool-call-model'

const COMPACTION_KEY = {
  in_progress: 'inProgress',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
} as const

/**
 * A step of the thread's work on affectUI's Tool Call Card: a tool call, a thought or a
 * compaction. Its facts come as props of their own (tool-call-model.ts), which a group reads.
 * `note` follows a tool call's target, such as who allowed it.
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
}: Omit<StepFacts, 'glyph'> & {
  sessionId: string
  entry: ThreadEntry
  projectPath: string
  labels: Partial<ToolCallLabels>
  note?: string
  icon: ReactNode
}) {
  const { t } = useTranslation('session')
  const facts = { status, startedAt, duration, time, icon, labels, chevron: 'before' as const }
  if (entry.kind === 'tool') {
    const label = toolLabel(entry, projectPath, entry.status === 'completed')
    const pictures = entryPictures(entry)
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
          <ToolBody sessionId={sessionId} entryId={entry.id} projectPath={projectPath} />
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
        {entry.markdown.trim() ? <ThoughtBody sessionId={sessionId} entryId={entry.id} /> : false}
      </ToolCallCard>
    )
  }
  if (entry.kind === 'compaction') {
    return (
      <ToolCallCard {...facts} name={t(`compaction.${COMPACTION_KEY[entry.status]}`)}>
        {entry.summary ? (
          <div data-selectable="" className="text-muted-foreground">
            <Markdown
              markdown={entry.summary}
              streaming={entry.status === 'in_progress'}
              className="markdown-muted"
            />
          </div>
        ) : (
          false
        )}
      </ToolCallCard>
    )
  }
  return null
}
