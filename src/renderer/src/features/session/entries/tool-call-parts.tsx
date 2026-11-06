import { memo, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { ToolEntry } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { Clamp } from '../clamp'
import { Markdown } from '../markdown'
import { EntryIdContext, SessionIdContext } from '../media/grants'
import { toolMedia } from '../media/named'
import { useEntry } from '../use-thread'
import { commandOutput, toolLabel } from './helpers'
import { ShellBlock } from './shell-block'
import { ContentBlock, ToolMedia } from './tool-parts'
import { useDiffStats } from './use-diff-stats'

/** A tool call's details: its command and what it printed, its content and its pictures. */
export const ToolBody = memo(function ToolBody({
  sessionId,
  entryId,
  projectPath,
}: {
  sessionId: string
  entryId: string
  projectPath: string
}) {
  const { t } = useTranslation('session')
  const entry = useEntry(sessionId, entryId, 'tool')
  const media = useMemo(() => (entry ? toolMedia(entry) : []), [entry])
  if (!entry) return null
  const label = toolLabel(entry, projectPath, entry.status === 'completed')
  const command = label.kind === 'command' ? label.target : null
  // A command's output shows under it, in the same block, as a terminal prints it.
  const output = command ? commandOutput(entry.content) : null
  const content = output === null ? entry.content : entry.content.slice(1)
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
      {content.map((c, i) => (
        <ContentBlock
          key={i}
          sessionId={sessionId}
          entryId={entryId}
          index={output === null ? i : i + 1}
          content={c}
          projectPath={projectPath}
        />
      ))}
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
      {line}
      {stats && (stats.insertions > 0 || stats.deletions > 0) && (
        <span className="ks-tool-stats tabular">
          {' '}
          +{stats.insertions} −{stats.deletions}
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
    <div data-selectable="" className="text-muted-foreground">
      <SessionIdContext value={sessionId}>
        <EntryIdContext value={entryId}>
          <Clamp maxHeight={180} buttonClassName="-mx-1.5">
            <Markdown
              markdown={entry.markdown}
              streaming={entry.streaming}
              className="markdown-muted markdown-thought"
            />
          </Clamp>
        </EntryIdContext>
      </SessionIdContext>
    </div>
  )
})
