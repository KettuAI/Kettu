import { memo, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Icon } from '@renderer/components/affect/app-shell'
import { ToolCallGroup } from '@renderer/components/affect/tool-call-card'
import { cn } from '@renderer/lib/utils'
import { useThreadsStore } from '@renderer/stores/threads'
import { useEntryAnimation } from '../use-thread'
import { groupLabel, toolStep } from './helpers'
import { RowThumbs } from './row-thumbs'
import { StepCard, StepStub } from './tool-call'
import { runPictures, stepFacts, useToolCallLabels } from './tool-call-model'
import { useOpenedOnce } from './use-opened'

/** A run of completed lookups as one line ("Read a.ts and 2 more"), opening to a card for each. */
export const ToolGroup = memo(function ToolGroup({
  sessionId,
  entryIds,
  projectPath,
}: {
  sessionId: string
  entryIds: string[]
  projectPath: string
  agentName: string
}) {
  const labels = useToolCallLabels()
  const animation = useEntryAnimation(sessionId, entryIds[0]!)
  const entries = useThreadsStore(
    useShallow((s) => {
      const byId = s.replicas[sessionId]?.state?.byId
      return entryIds.map((id) => byId?.[id])
    }),
  )
  const tools = entries.flatMap((entry) => (entry?.kind === 'tool' ? [entry] : []))
  const pictures = useMemo(() => runPictures(entries), [entries])
  const label = groupLabel(tools.map(toolStep))
  const [opened, onOpenChange] = useOpenedOnce()
  return (
    <ToolCallGroup
      className={cn('min-w-0', animation)}
      label={label}
      runningLabel={label}
      chevron="before"
      labels={labels}
      time={false}
      trail={
        pictures.length > 0 ? <RowThumbs sessionId={sessionId} pictures={pictures} /> : undefined
      }
      onOpenChange={onOpenChange}
    >
      {tools.map((entry) => {
        const { glyph, ...facts } = stepFacts(sessionId, entry)!
        const icon = <Icon icon={glyph} size={14} />
        if (!opened) return <StepStub key={entry.id} {...facts} icon={icon} />
        return (
          <StepCard
            key={entry.id}
            {...facts}
            icon={icon}
            sessionId={sessionId}
            entry={entry}
            projectPath={projectPath}
            labels={labels}
          />
        )
      })}
    </ToolCallGroup>
  )
})
