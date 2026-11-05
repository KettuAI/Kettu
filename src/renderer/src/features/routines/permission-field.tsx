// A routine's permission scope as rows of its card: three levels, the web switch, and a caption.

import { EyeIcon, InfoIcon, PencilIcon, SquareTerminalIcon, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PermissionScope } from '@shared/routines'
import type { AgentId } from '@shared/thread'
import { RadioGroup, RadioGroupItem } from '@renderer/components/ui/radio-group'
import { Switch } from '@renderer/components/ui/switch'
import { cn } from '@renderer/lib/utils'
import { CARD_ROWS } from './fields'

const LEVELS: readonly { level: PermissionScope['level']; icon: LucideIcon }[] = [
  { level: 'read', icon: EyeIcon },
  { level: 'edit', icon: PencilIcon },
  { level: 'commands', icon: SquareTerminalIcon },
]

const CAPTIONS = {
  'claude-code': true,
  codex: true,
  opencode: true,
  pi: true,
} satisfies Partial<Record<AgentId, true>>

function hasCaption(agentId: AgentId): agentId is keyof typeof CAPTIONS {
  return agentId in CAPTIONS
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
    <>
      <RadioGroup
        aria-label={t('permission.levels')}
        value={scope.level}
        onValueChange={(level: PermissionScope['level']) => onChange({ ...scope, level })}
        className={cn('gap-0', CARD_ROWS)}
      >
        {LEVELS.map(({ level, icon: Icon }) => (
          <label
            key={level}
            className="flex cursor-default items-start gap-3 px-4.5 py-3.25 transition-colors duration-(--duration-fast) not-has-data-checked:hover:bg-hover has-data-checked:bg-control-on-tint"
          >
            <RadioGroupItem value={level} className="mt-0.5" />
            <span className="flex min-w-0 flex-1 flex-col gap-px">
              <span className="text-lede leading-5 font-medium">
                {t(`permission.level.${level}.name`)}
              </span>
              <span className="text-hint text-pretty text-tertiary">
                {t(`permission.level.${level}.description`)}
              </span>
            </span>
            <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-tertiary" />
          </label>
        ))}
      </RadioGroup>
      <label className="flex min-h-16.5 cursor-default items-center gap-6 px-4.5 py-3.5">
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="text-lede leading-5 font-medium">{t('permission.web.name')}</span>
          <span className="text-hint text-pretty text-tertiary">
            {t('permission.web.description')}
          </span>
        </span>
        <Switch
          checked={scope.web}
          onCheckedChange={(web) => onChange({ ...scope, web })}
          aria-label={t('permission.web.name')}
        />
      </label>
      {caption && (
        <p className="flex gap-2 px-4.5 py-3 text-hint text-pretty text-tertiary">
          <InfoIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {caption}
        </p>
      )}
    </>
  )
}
