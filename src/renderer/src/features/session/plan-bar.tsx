import { useState } from 'react'
import { ChevronRightIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PlanItem } from '@shared/thread'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import { cn } from '@renderer/lib/utils'
import { useThreadsStore } from '@renderer/stores/threads'
import { PlanList } from './entries/basic'
import { PANEL } from './entries/helpers'

/**
 * The latest plan, pinned above the composer as one row: a segment per step, the count and the
 * current step. It opens upward to the whole list, and steps aside while the queue fans out over
 * it (`hidden`).
 */
export function PlanBar({
  sessionId,
  running,
  hidden,
}: {
  sessionId: string
  running: boolean
  hidden: boolean
}) {
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
      inert={hidden}
      aria-hidden={hidden || undefined}
      className={cn(
        'mb-2 transition-[opacity,translate] duration-(--duration-fast) ease-out-quart',
        hidden && '-translate-y-1 opacity-0 motion-reduce:translate-y-0',
      )}
    >
      <CollapsibleTrigger className="flex h-row w-full items-center gap-2.5 rounded-lg px-4 text-left outline-none transition-colors duration-(--duration-fast) hover:bg-hover focus-ring">
        <ChevronRightIcon
          aria-hidden
          className={cn(
            'size-3 shrink-0 text-icon transition-transform duration-(--duration-fast) motion-reduce:transition-none',
            open && 'rotate-90',
          )}
        />
        <span className="shrink-0 text-xs text-muted-foreground">{t('planBar.label')}</span>
        <Segments items={plan.items} />
        <span
          key={done}
          aria-hidden
          className="shrink-0 animate-in text-xs text-muted-foreground tabular fade-in animation-duration-(--duration-base)"
        >
          {t('planBar.count', { done, total: plan.items.length })}
        </span>
        <span className="sr-only">{t('planBar.progress', { done, total: plan.items.length })}</span>
        {current && !open && (
          <span
            key={current.content}
            className="min-w-0 flex-1 animate-in truncate text-small font-medium text-primary fade-in animation-duration-(--duration-base)"
          >
            {current.content}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className={PANEL}>
        <div className="max-h-42 scroll-fade-y overflow-y-auto overscroll-contain pt-1 pr-2 pb-0.5 pl-4">
          <PlanList items={plan.items} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** One segment per step: done, current and to do. Past eight steps they share a fixed width. */
function Segments({ items }: { items: PlanItem[] }) {
  const crowded = items.length > 8
  return (
    <span aria-hidden className={cn('flex shrink-0 gap-0.5', crowded && 'w-28')}>
      {items.map((item, i) => (
        <span
          key={i}
          className={cn(
            'h-1 rounded-full transition-colors duration-(--duration-base)',
            crowded ? 'min-w-px flex-1' : 'w-3.5',
            item.status === 'completed'
              ? 'bg-current text-secondary'
              : item.status === 'in_progress'
                ? 'bg-current text-tertiary'
                : 'bg-border',
          )}
        />
      ))}
    </span>
  )
}
