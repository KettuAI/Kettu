import { Alert02Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import { RingSpinner } from '@renderer/components/ui/spinner'
import { subagentRunning } from '@renderer/features/session/subagent/progress'
import { Glyph } from '@renderer/features/shell/glyph'
import { subagentFailed } from './subagents'

/** What a sub-agent is doing in a list of them: waiting for you, failed, running or done. */
export function SubagentStatus({ child }: { child: SessionSummary }) {
  const { t } = useTranslation('sidebar')
  return (
    <span className="grid w-4 shrink-0 place-items-center">
      {child.permissionCount > 0 ? (
        <span
          role="img"
          aria-label={t('indicator.waiting', { count: child.permissionCount })}
          className="size-2 rounded-full bg-attention-dot shadow-[0_0_0_3px_var(--attention-halo)]"
        />
      ) : subagentFailed(child) ? (
        <span role="img" aria-label={t('indicator.error')} className="grid text-danger">
          <Glyph icon={Alert02Icon} size={14} />
        </span>
      ) : subagentRunning(child) ? (
        <RingSpinner aria-label={t('indicator.running')} className="size-[11.5px] border-[1.6px]" />
      ) : (
        <span role="img" aria-label={t('subagents.done')} className="grid text-success">
          <Glyph icon={Tick02Icon} size={12} />
        </span>
      )}
    </span>
  )
}
