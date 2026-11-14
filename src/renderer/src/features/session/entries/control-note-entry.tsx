import { memo } from 'react'
import { Cursor02Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { Trans, useTranslation } from 'react-i18next'
import { Marker, MarkerContent, MarkerIcon } from '@renderer/components/ui/marker'
import { duration } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'
import { useEntry, useEntryAnimation } from '../use-thread'
import type { EntryProps } from './basic'

/** A quiet line across the thread where the user took a surface over and handed it back. */
export const ControlNoteEntry = memo(function ControlNoteEntry({ sessionId, entryId }: EntryProps) {
  const { t } = useTranslation('control')
  const entry = useEntry(sessionId, entryId, 'control_note')
  const animation = useEntryAnimation(sessionId, entryId)
  if (!entry) return null
  return (
    <Marker variant="separator" className={cn('text-xs', animation)}>
      <MarkerIcon className="size-3.5">
        <HugeiconsIcon icon={Cursor02Icon} strokeWidth={1.9} aria-hidden className="size-3.5" />
      </MarkerIcon>
      <MarkerContent>
        <Trans
          t={t}
          i18nKey={`note.handedBack.${entry.surface}`}
          values={{ duration: duration(entry.durationMs) }}
          components={{ b: <b className="font-medium text-secondary" /> }}
        />
      </MarkerContent>
    </Marker>
  )
})
