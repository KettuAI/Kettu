// A routine's permission scope: three levels as a radio list, the web switch, and a caption.

import { useTranslation } from 'react-i18next'
import type { PermissionScope } from '@shared/routines'
import type { AgentId } from '@shared/thread'
import { Switch } from '@renderer/components/ui/switch'

const LEVELS: readonly PermissionScope['level'][] = ['read', 'edit', 'commands']
const CAPTION_AGENTS = ['claude-code', 'codex', 'opencode', 'pi'] as const

function hasCaption(agentId: AgentId): agentId is (typeof CAPTION_AGENTS)[number] {
  return (CAPTION_AGENTS as readonly AgentId[]).includes(agentId)
}

/** A choice's focus ring, drawn inside it, since its card clips what reaches past its corners. */
const INSET_FOCUS =
  'has-focus-visible:outline-2 has-focus-visible:-outline-offset-2 has-focus-visible:outline-focus'

export function PermissionField({
  scope,
  agentId,
  onChange,
}: {
  scope: PermissionScope
  agentId: AgentId | null
  onChange: (scope: PermissionScope) => void
}) {
  const { t } = useTranslation('routines')
  const caption =
    agentId !== null && hasCaption(agentId) ? t(`permission.caption.${agentId}`) : null
  return (
    <div className="flex w-full flex-col gap-2.5">
      <div
        role="radiogroup"
        aria-label={t('permission.levels')}
        className="flex flex-col overflow-hidden rounded-xl bg-card shadow-card"
      >
        {LEVELS.map((level) => (
          <label
            key={level}
            className={`group/level flex cursor-default items-start gap-3 px-3.5 py-3 transition-colors duration-(--duration-fast) not-first:border-t not-first:border-subtle hover:bg-hover ${INSET_FOCUS}`}
          >
            <input
              type="radio"
              name="routine-scope"
              value={level}
              checked={scope.level === level}
              onChange={() => onChange({ ...scope, level })}
              className="sr-only"
            />
            <span
              aria-hidden
              className="mt-0.75 grid size-3.5 shrink-0 place-items-center rounded-full bg-card ring-1 ring-border-strong transition-colors duration-(--duration-fast) ring-inset group-has-[:checked]/level:bg-primary group-has-[:checked]/level:ring-0"
            >
              <span className="size-1.5 scale-0 rounded-full bg-card transition-transform duration-(--duration-fast) group-has-[:checked]/level:scale-100" />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-ui font-medium">{t(`permission.level.${level}.name`)}</span>
              <span className="text-xs leading-normal text-pretty text-secondary">
                {t(`permission.level.${level}.description`)}
              </span>
            </span>
          </label>
        ))}
      </div>
      <label className="flex cursor-default items-center gap-3 rounded-xl bg-card px-3.5 py-3 shadow-card">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-ui font-medium">{t('permission.web.name')}</span>
          <span className="text-xs leading-normal text-pretty text-secondary">
            {t('permission.web.description')}
          </span>
        </span>
        <Switch
          checked={scope.web}
          onCheckedChange={(web) => onChange({ ...scope, web })}
          aria-label={t('permission.web.name')}
        />
      </label>
      {caption && <p className="text-xs leading-normal text-pretty text-tertiary">{caption}</p>}
    </div>
  )
}
