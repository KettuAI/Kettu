// A routine's permission scope: three levels as a radio list, the web switch, and a caption.

import { useTranslation } from 'react-i18next'
import type { PermissionScope } from '@shared/routines'
import type { AgentId } from '@shared/thread'
import { Switch } from '@renderer/components/ui/switch'

const LEVELS: readonly PermissionScope['level'][] = ['read', 'edit', 'commands']
const CAPTION_AGENTS = ['claude-code', 'codex', 'opencode'] as const

function hasCaption(agentId: AgentId): agentId is (typeof CAPTION_AGENTS)[number] {
  return (CAPTION_AGENTS as readonly AgentId[]).includes(agentId)
}

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
    <div className="flex flex-col gap-1">
      <div role="radiogroup" aria-label={t('permission.levels')} className="flex flex-col">
        {LEVELS.map((level) => (
          <label
            key={level}
            className="group/level flex cursor-default items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors duration-(--duration-fast) hover:bg-hover focus-ring-within"
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
              className="mt-[3px] grid size-3.5 shrink-0 place-items-center rounded-full ring-1 ring-border-strong transition-colors duration-(--duration-fast) ring-inset group-has-[:checked]/level:bg-primary group-has-[:checked]/level:ring-0"
            >
              <span className="size-1.5 scale-0 rounded-full bg-background transition-transform duration-(--duration-fast) group-has-[:checked]/level:scale-100" />
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
      <div className="mt-1 flex items-center gap-6 border-t border-subtle px-2 pt-2.5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-ui font-medium">{t('permission.web.name')}</span>
          <span className="text-xs leading-normal text-pretty text-secondary">
            {t('permission.web.description')}
          </span>
        </div>
        <Switch
          checked={scope.web}
          onCheckedChange={(web) => onChange({ ...scope, web })}
          aria-label={t('permission.web.name')}
        />
      </div>
      {caption && (
        <p className="mt-1.5 px-2 text-xs leading-normal text-pretty text-tertiary">{caption}</p>
      )}
    </div>
  )
}
