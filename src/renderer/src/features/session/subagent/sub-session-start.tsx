import { ArrowMoveDownRightIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { Trans, useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import { MODE_GLYPH, modeLook } from '../composer/modes'
import { useSessionView } from '../use-thread'

/**
 * The first line of a sub-session: the session it started from (which it opens) and the child's
 * current effective permission mode when the agent reports one.
 */
export function SubSessionStart({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('session')
  const { t: tc } = useTranslation('composer')
  const parent = useSessionsStore((s) => {
    const summary = s.byId[sessionId]
    return summary?.origin === 'user' && summary.parentId ? s.byId[summary.parentId] : undefined
  })
  const config = useSessionView(sessionId)?.config
  if (!parent) return null
  const mode = config?.find((option) => option.category === 'mode' && option.type === 'select')
  const modeValue = typeof mode?.value === 'string' ? mode.value : undefined
  const modeLabel =
    modeValue !== undefined
      ? (mode?.choices?.find((choice) => choice.value === modeValue)?.name ?? modeValue)
      : null
  const look = modeValue !== undefined ? modeLook(modeValue) : null
  return (
    <div className="mb-4 flex items-center gap-2 rounded-tile bg-subtle px-2.5 py-2 text-hint text-secondary">
      <HugeiconsIcon
        icon={ArrowMoveDownRightIcon}
        strokeWidth={1.9}
        aria-hidden
        className="size-3.5 shrink-0 text-tertiary"
      />
      <p className="min-w-0 flex-1">
        <Trans
          t={t}
          i18nKey="subSession.startedFrom"
          values={{ title: sessionTitle(parent) }}
          components={{
            parent: (
              <button
                type="button"
                className="rounded-sm font-medium text-primary decoration-border-strong underline-offset-3 outline-none hover:underline focus-ring"
                onClick={() => openSession(parent.id, parent.projectPath)}
              />
            ),
          }}
        />
      </p>
      {modeLabel !== null && look !== null && (
        <span
          aria-label={`${tc('controls.permissionMode')}: ${modeLabel}`}
          title={tc('controls.permissionMode')}
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-caption font-medium',
            look === 'full' ? 'bg-danger/10 text-danger' : 'text-secondary',
          )}
        >
          <HugeiconsIcon
            icon={MODE_GLYPH[look]}
            strokeWidth={1.9}
            aria-hidden
            className="size-3 shrink-0"
          />
          <span>{modeLabel}</span>
        </span>
      )}
    </div>
  )
}
