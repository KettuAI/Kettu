import { ArrowMoveDownRightIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { Trans, useTranslation } from 'react-i18next'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'

/**
 * The first line of a sub-session the user started: the session it started from, which it opens.
 * Nothing else is handed over, so it names nothing more.
 */
export function SubSessionStart({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('session')
  const parent = useSessionsStore((s) => {
    const summary = s.byId[sessionId]
    return summary?.origin === 'user' && summary.parentId ? s.byId[summary.parentId] : undefined
  })
  if (!parent) return null
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
    </div>
  )
}
