import { useState } from 'react'
import { ChevronUpIcon, ListChecksIcon } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
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
  const { t } = useTranslation('session')
  const [open, setOpen] = useState(false)
  const plan = useThreadsStore((s) => {
    const replica = s.replicas[sessionId]
    const state = replica?.state
    if (!state) return null
    for (let i = state.order.length - 1; i >= 0; i--) {
      const entry = state.byId[state.order[i]!]
      if (entry?.kind === 'plan') return entry
    }
    // The latest plan lies on a page not loaded yet.
    return replica.plan
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
          <Trans
            t={t}
            i18nKey="planBar.progress"
            components={{
              count: <PlanCount done={done} total={plan.items.length} />,
            }}
          />
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

function PlanCount({ done, total }: { done: number; total: number }) {
  return (
    <span
      key={done}
      className="inline-block animate-in fade-in slide-in-from-bottom-1 animation-duration-(--duration-base)"
    >
      {done}/{total}
    </span>
  )
}
