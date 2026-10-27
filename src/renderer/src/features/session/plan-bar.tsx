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
 * The row above the composer: the latest plan, as a segment per step, the count and the current
 * step, which opens to the whole list under it. It steps aside while the queue fans out over it
 * (`hidden`).
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
  const items = plan && plan.items.length > 0 ? plan.items : null
  const done = items ? items.filter((i) => i.status === 'completed').length : 0
  const showsPlan = !!items && (running || done < items.length)
  if (!showsPlan) return null

  const shell = cn(
    'transition-[opacity,translate] duration-(--duration-fast) ease-out-quart',
    hidden && '-translate-y-1 opacity-0 motion-reduce:translate-y-0',
  )
  const row = 'flex min-h-7.5 min-w-0 items-center gap-2 px-1 pb-1'
  const current = items.find((i) => i.status === 'in_progress')

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      inert={hidden}
      aria-hidden={hidden || undefined}
      className={shell}
    >
      <div className={row}>
        <CollapsibleTrigger className="-ml-2 flex h-7 min-w-0 items-center gap-2 rounded-lg px-2 text-left text-ui text-tertiary outline-none transition-colors duration-(--duration-fast) hover:bg-hover focus-ring">
          <ChevronRightIcon
            aria-hidden
            className={cn(
              'size-3.5 shrink-0 transition-transform duration-(--duration-fast) motion-reduce:transition-none',
              open && 'rotate-90',
            )}
          />
          <span className="shrink-0">{t('planBar.label')}</span>
          <Segments items={items} />
          <span
            key={done}
            aria-hidden
            className="shrink-0 animate-in tabular fade-in animation-duration-(--duration-base)"
          >
            {t('planBar.count', { done, total: items.length })}
          </span>
          <span className="sr-only">{t('planBar.progress', { done, total: items.length })}</span>
          {current && (
            <span
              key={current.content}
              className="min-w-0 animate-in truncate font-medium text-foreground fade-in animation-duration-(--duration-base)"
            >
              {current.content}
            </span>
          )}
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className={PANEL}>
        <div className="max-h-42 scroll-fade-y overflow-y-auto overscroll-contain pt-1 pr-2 pb-2 pl-3.5">
          <PlanList items={items} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** One segment per step: done, current and to do. Past eight steps they share a fixed width. */
function Segments({ items }: { items: PlanItem[] }) {
  const crowded = items.length > 8
  return (
    <span aria-hidden className={cn('flex shrink-0 gap-0.75', crowded && 'w-28')}>
      {items.map((item, i) => (
        <span
          key={i}
          className={cn(
            'h-1 rounded-xs transition-colors duration-(--duration-base)',
            crowded ? 'min-w-px flex-1' : 'w-3.5',
            item.status === 'completed'
              ? 'bg-current text-secondary'
              : item.status === 'in_progress'
                ? 'bg-current text-tertiary'
                : 'bg-border-strong',
          )}
        />
      ))}
    </span>
  )
}
