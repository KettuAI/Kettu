import { memo, useState } from 'react'
import { ArrowDataTransferHorizontalIcon, ArrowRight01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import { Marker, MarkerContent, MarkerIcon } from '@renderer/components/ui/marker'
import { cn } from '@renderer/lib/utils'
import { AGENT_NAMES, useAgentsStore } from '@renderer/stores/agents'
import { harnessOf } from '@shared/thread'
import { useEntry, useEntryAnimation } from '../use-thread'
import { PANEL } from './helpers'
import type { EntryProps } from './basic'

/**
 * Where another agent took the session over: a quiet line across the thread that opens on what it
 * was given of the conversation before it, once its first turn went.
 */
export const TakeoverEntry = memo(function TakeoverEntry({ sessionId, entryId }: EntryProps) {
  const { t } = useTranslation('session')
  const entry = useEntry(sessionId, entryId, 'takeover')
  const animation = useEntryAnimation(sessionId, entryId)
  const name = useAgentsStore((s) =>
    entry ? (s.byId[entry.agentId]?.name ?? AGENT_NAMES[harnessOf(entry.agentId)]) : '',
  )
  const [open, setOpen] = useState(false)
  if (!entry) return null
  const text =
    entry.turns > 0
      ? t('takeover.carried', { agent: name, count: entry.turns })
      : t('takeover.title', { agent: name })
  const icon = (
    <HugeiconsIcon
      icon={ArrowDataTransferHorizontalIcon}
      strokeWidth={1.9}
      aria-hidden
      className="size-3.5"
    />
  )
  if (!entry.carried) {
    return (
      <Marker variant="separator" className={cn('text-xs', animation)}>
        <MarkerIcon className="size-3.5">{icon}</MarkerIcon>
        <MarkerContent>{text}</MarkerContent>
      </Marker>
    )
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={animation}>
      <Marker
        variant="separator"
        className="text-xs"
        render={<CollapsibleTrigger className="group/takeover outline-none" />}
      >
        <MarkerIcon className="size-3.5">{icon}</MarkerIcon>
        <MarkerContent className="inline-flex items-center gap-1 group-hover/takeover:text-foreground">
          {text}
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            strokeWidth={1.9}
            aria-hidden
            className="size-3 transition-transform duration-(--duration-fast) group-data-panel-open/takeover:rotate-90"
          />
        </MarkerContent>
      </Marker>
      <CollapsibleContent className={PANEL}>
        <div className="mt-2 rounded-xl bg-card px-3.5 py-2.5 shadow-card" data-selectable="">
          <p className="mb-1.5 text-xs text-tertiary">
            {entry.omitted > 0
              ? t('takeover.omitted', { count: entry.omitted })
              : t('takeover.whole')}
          </p>
          <pre className="max-h-80 overflow-auto font-sans text-xs/5 whitespace-pre-wrap text-muted-foreground">
            {entry.carried}
          </pre>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
})
