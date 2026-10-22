import { memo, useState } from 'react'
import { ChevronRightIcon, TelescopeIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Card } from '@renderer/components/ui/card'
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
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      render={<Card variant="tool" className={animation} />}
    >
      <CollapsibleTrigger className="group/tool flex h-card-header w-full items-center gap-2 rounded-[inherit] px-3 text-left outline-none transition-colors duration-(--duration-fast) hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset">
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
        <div className="flex flex-col border-t border-border-soft py-0.5">
          {entryIds.map((id) => (
            <ToolCard
              key={id}
              sessionId={sessionId}
              entryId={id}
              projectPath={projectPath}
              agentName={agentName}
              nested
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
})
