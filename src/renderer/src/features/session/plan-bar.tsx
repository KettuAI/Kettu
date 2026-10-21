import { useState } from 'react'
import { ChevronUpIcon, ListChecksIcon } from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import { cn } from '@renderer/lib/utils'
import { useThreadsStore } from '@renderer/stores/threads'
import { PlanList } from './entries/basic'
import { PANEL } from './entries/helpers'

/** The latest plan, pinned above the composer as "Plan 3/5"; it expands in place. */
export function PlanBar({ sessionId, running }: { sessionId: string; running: boolean }) {
  const [open, setOpen] = useState(false)
  const plan = useThreadsStore((s) => {
    const state = s.replicas[sessionId]?.state
    if (!state) return null
    for (let i = state.order.length - 1; i >= 0; i--) {
      const entry = state.byId[state.order[i]!]
      if (entry?.kind === 'plan') return entry
    }
    return null
  })
  if (!plan || plan.items.length === 0) return null
  const done = plan.items.filter((i) => i.status === 'completed').length
  if (done === plan.items.length && !running) return null
  const current = plan.items.find((i) => i.status === 'in_progress')

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="mx-3 overflow-hidden rounded-t-xl bg-card/80 shadow-card"
    >
      <CollapsibleTrigger className="group/plan flex h-row w-full items-center gap-2 px-3 text-left text-xs outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset">
        <ListChecksIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium tabular">
          Plan{' '}
          <span
            key={done}
            className="inline-block animate-in fade-in slide-in-from-bottom-1 animation-duration-(--duration-base)"
          >
            {done}/{plan.items.length}
          </span>
        </span>
        {current && !open && (
          <span
            key={current.content}
            className="min-w-0 flex-1 animate-in truncate text-muted-foreground fade-in animation-duration-(--duration-base)"
          >
            {current.content}
          </span>
        )}
        <ChevronUpIcon
          className={cn(
            'ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--duration-fast)',
            open && 'rotate-180',
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className={PANEL}>
        <div className="max-h-[40svh] overflow-y-auto border-t border-border-soft px-3 py-2">
          <PlanList items={plan.items} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
