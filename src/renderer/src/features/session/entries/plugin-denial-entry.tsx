import { memo } from 'react'
import { AlertCircleIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { Trans, useTranslation } from 'react-i18next'
import { Marker, MarkerContent, MarkerIcon } from '@renderer/components/ui/marker'
import { cn } from '@renderer/lib/utils'
import { useEntry, useEntryAnimation } from '../use-thread'
import type { EntryProps } from './basic'

/** A quiet red line across the thread where a plugin denied a permission request. */
export const PluginDenialEntry = memo(function PluginDenialEntry({
  sessionId,
  entryId,
}: EntryProps) {
  const { t } = useTranslation('session')
  const entry = useEntry(sessionId, entryId, 'plugin_denial')
  const animation = useEntryAnimation(sessionId, entryId)
  if (!entry) return null
  const b = <b className="font-medium" dir="auto" />
  return (
    <Marker variant="separator" className={cn('text-xs text-danger', animation)}>
      <MarkerIcon className="size-3.5">
        <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={1.9} aria-hidden className="size-3.5" />
      </MarkerIcon>
      <MarkerContent data-selectable="">
        <Trans
          t={t}
          i18nKey="pluginDenial.text"
          values={{ plugin: entry.plugin, request: entry.request, reason: entry.reason }}
          components={{ b }}
        />
      </MarkerContent>
    </Marker>
  )
})
