import { Clock01Icon, ComputerTerminal01Icon, ViewIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { RingSpinner } from '@renderer/components/ui/spinner'
import { Glyph } from '@renderer/features/shell/glyph'
import { cn } from '@renderer/lib/utils'
import type { WorkItem } from './running-work'

/** What a confirmation says will stop, one row each, as the quit confirmation lists its work. */
export function RunningWorkList({ items, className }: { items: WorkItem[]; className?: string }) {
  const { t } = useTranslation('sidebar')
  return (
    <ul className={cn('flex max-h-60 flex-col overflow-y-auto text-ui', className)}>
      {items.map((item) => {
        // A background command is named by what the agent said it does; a terminal by its command.
        const mono = item.kind === 'terminal'
        return (
          <li
            key={item.key}
            className="flex h-8.5 shrink-0 items-center gap-2.5 border-b border-border-soft"
          >
            {item.kind === 'command' || item.kind === 'terminal' ? (
              <Glyph icon={ComputerTerminal01Icon} className="text-icon" />
            ) : item.kind === 'task' ? (
              <Glyph icon={ViewIcon} className="text-icon" />
            ) : item.kind === 'scheduled' ? (
              <Glyph icon={Clock01Icon} className="text-icon" />
            ) : (
              item.agentId && <AgentMark agent={item.agentId} hostId={item.hostId} size={16} />
            )}
            <span className={cn('min-w-0 flex-1 truncate', mono && 'font-mono text-xs')}>
              {item.name}
            </span>
            <span className="flex shrink-0 items-center gap-2 text-small text-tertiary">
              {item.kind === 'turn' && <RingSpinner aria-hidden />}
              {t(`work.${item.kind}`, { count: item.count })}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
