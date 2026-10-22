import { memo, useState } from 'react'
import { ChevronRightIcon, TelescopeIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import { cn } from '@renderer/lib/utils'
import { useThreadsStore } from '@renderer/stores/threads'
import { useShallow } from 'zustand/react/shallow'
import { useEntryAnimation } from '../use-thread'
import { groupLabel, PANEL } from './helpers'
import { ToolCard } from './tool-card'

/** A run of completed lookups as one row ("Explored 4 files"), opening to a row for each. */
export const ToolGroup = memo(function ToolGroup({
  sessionId,
  entryIds,
  projectPath,
  agentName,
}: {
  sessionId: string
  entryIds: string[]
  projectPath: string
  agentName: string
}) {
  useTranslation('session')
  const [open, setOpen] = useState(false)
  const animation = useEntryAnimation(sessionId, entryIds[0]!)
  const kinds = useThreadsStore(
    useShallow((s) => {
      const byId = s.replicas[sessionId]?.state?.byId
      return entryIds.map((id) => {
        const entry = byId?.[id]
        return entry?.kind === 'tool' ? entry.toolKind : 'other'
      })
    }),
  )
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn('min-w-0', animation)}>
      <CollapsibleTrigger className="group/tool -mx-1.5 flex h-6 w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 text-left text-[13px] text-muted-foreground outline-none transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset">
        <span className="relative flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
          <TelescopeIcon className="size-3.5 transition-opacity duration-(--duration-fast) group-hover/tool:opacity-0" />
          <ChevronRightIcon
            aria-hidden
            className={cn(
              'absolute size-3.5 opacity-0 transition-[opacity,rotate] duration-(--duration-fast) group-hover/tool:opacity-100',
              open && 'rotate-90',
            )}
          />
        </span>
        <span
          key={entryIds.length}
          className="min-w-0 flex-1 truncate animate-in fade-in animation-duration-(--duration-base)"
        >
          {groupLabel(kinds)}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className={PANEL}>
        <div className="mt-0.5 ml-1.5 flex flex-col gap-0.5 border-l border-border pl-3.5">
          {entryIds.map((id) => (
            <ToolCard
              key={id}
              sessionId={sessionId}
              entryId={id}
              projectPath={projectPath}
              agentName={agentName}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
})
