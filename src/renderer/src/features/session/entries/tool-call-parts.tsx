import { memo, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { hasToolDigest, toolContentItems, type ToolEntry } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import { ToolCallSection } from '@renderer/components/affect/tool-call-card'
import { Button } from '@renderer/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { Spinner } from '@renderer/components/ui/spinner'
import { errorMessage } from '@renderer/lib/host'
import { loadFullEntry } from '@renderer/stores/threads'
import { toolMedia } from '../media/named'
import { useEntry } from '../use-thread'
import { commandOutput, toolLabel } from './helpers'
import { fenceBody, numberedRead } from './read-code'
import { ShellBlock } from './shell-block'
import { ThoughtSummaryView } from './thought-translation'
import { useToolCallLabels } from './tool-call-model'
import { ContentBlock, ToolMedia } from './tool-parts'
import { useDiffStats } from './use-diff-stats'

/**
 * A tool call's details, as sections of its step's card: its command and what it printed, its text
 * result or the file it read, its changes, and its pictures.
 */
export const ToolBody = memo(function ToolBody({
  sessionId,
  entryId,
  projectPath,
}: {
  sessionId: string
  entryId: string
  projectPath: string
}) {
  const { t } = useTranslation(['session', 'common'])
  const labels = useToolCallLabels()
  const entry = useEntry(sessionId, entryId, 'tool')
  const needsFull = hasToolDigest(entry)
  const [loadError, setLoadError] = useState<{ attempt: number; message: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!needsFull) return
    let active = true
    void loadFullEntry(sessionId, entryId).catch((error: unknown) => {
      if (active) setLoadError({ attempt, message: errorMessage(error) })
    })
    return () => {
      active = false
    }
  }, [needsFull, sessionId, entryId, attempt])
  const activeError = loadError?.attempt === attempt ? loadError.message : null
  const media = useMemo(() => (entry ? toolMedia(entry) : []), [entry])
  if (!entry) return null
  if (needsFull) {
    return activeError ? (
      <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
        <span className="min-w-0 truncate" title={activeError}>
          {activeError}
        </span>
        <Button size="xs" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
          {t('common:actions.retry')}
        </Button>
      </div>
    ) : (
      <div className="flex items-center justify-center py-3">
        <Spinner className="size-4 text-muted-foreground" />
      </div>
    )
  }
  const label = toolLabel(entry, projectPath, entry.status === 'completed')
  const command = label.kind === 'command' ? label.target : null
  // A command's output shows under it, in the same block, as a terminal prints it.
  const items = toolContentItems(entry)
  const output = command ? commandOutput(items) : null
  const content = output === null ? entry.content : entry.content.slice(1)
  const path = entry.locations[0]?.path
  return (
    <>
      {command && (
        <ContextMenu>
          <ContextMenuTrigger render={<div className="min-w-0" />}>
            <ShellBlock
              sessionId={sessionId}
              projectPath={projectPath}
              command={command}
              output={output}
              status={entry.status}
            />
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem
              onClick={() => emitAppEvent({ kind: 'run-in-terminal', panel: sessionId, command })}
            >
              {t('tool.runInTerminal')}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => void navigator.clipboard.writeText(command)}>
              {t('tool.copyCommand')}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}
      {content.map((c, i) => {
        const block = (shown: typeof c) => (
          <ContentBlock
            key={i}
            sessionId={sessionId}
            entryId={entryId}
            index={output === null ? i : i + 1}
            content={shown}
            projectPath={projectPath}
          />
        )
        if (c.type === 'markdown') {
          const read = entry.toolKind === 'read' ? numberedRead(c.markdown, path) : null
          const markdown = read ?? c.markdown
          return (
            <ToolCallSection
              key={i}
              label={t(
                entry.toolKind === 'read' ? 'toolCall.section.content' : 'toolCall.section.result',
              )}
              copy={fenceBody(markdown)}
              labels={labels}
            >
              {block({ ...c, markdown })}
            </ToolCallSection>
          )
        }
        if (c.type === 'diff') {
          return (
            <ToolCallSection key={i} label={t('toolCall.section.changes')} labels={labels}>
              {block(c)}
            </ToolCallSection>
          )
        }
        return block(c)
      })}
      <ToolMedia sessionId={sessionId} entryId={entryId} media={media} />
    </>
  )
})

/** What the card says after the tool's name: its path or command, and an edit's counts. */
export function ToolSummary({
  entry,
  target,
  note,
}: {
  entry: ToolEntry
  target: string
  note?: string
}) {
  const stats = useDiffStats(entry.content)
  const line = target.split('\n')[0]!
  return (
    <span title={target}>
      <span className="ks-tool-target">{line}</span>
      {stats && (stats.insertions > 0 || stats.deletions > 0) && (
        <span className="ks-tool-stats tabular">
          {' '}
          <span className="ks-tool-add">+{stats.insertions}</span>{' '}
          <span className="ks-tool-del">−{stats.deletions}</span>
        </span>
      )}
      {note && <span className="ks-tool-note"> · {note}</span>}
    </span>
  )
}

/** A thought's text, muted, a few lines tall until shown whole. */
export const ThoughtBody = memo(function ThoughtBody({
  sessionId,
  entryId,
}: {
  sessionId: string
  entryId: string
}) {
  const entry = useEntry(sessionId, entryId, 'thought')
  if (!entry) return null
  return (
    <ThoughtSummaryView
      sessionId={sessionId}
      entryId={entryId}
      markdown={entry.markdown}
      streaming={entry.streaming}
      maxHeight={180}
    />
  )
})
