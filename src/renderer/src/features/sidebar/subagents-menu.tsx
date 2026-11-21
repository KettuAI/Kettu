import { BotIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { revealSubagent } from '@renderer/features/session/reveal-subagent'
import { MenuGlyph } from '@renderer/features/shell/glyph'
import { sessionTitle } from '@renderer/stores/sessions'
import { setShowFinishedSubagents } from '@renderer/stores/view'
import { SubagentStatus } from './subagent-status'

/**
 * A session's menu entry for its sub-agents, the same list the row's badge shows on hover, for
 * when the row's tools cover the badge. Each one jumps to its block in the session's thread.
 */
export function SubagentsMenu({
  parent,
  listed,
  showFinished,
}: {
  parent: SessionSummary
  /** The sub-agents the badge lists, from `listedSubagents`. */
  listed: readonly SessionSummary[]
  showFinished: boolean
}) {
  const { t } = useTranslation('sidebar')
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <MenuGlyph icon={BotIcon} />
        <span className="min-w-0 flex-1 truncate">{t('row.subagents')}</span>
        <span className="shrink-0 pl-4 text-hint text-tertiary tabular-nums">{listed.length}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('subagents.title')}</DropdownMenuLabel>
          {listed.map((child) => (
            <DropdownMenuItem key={child.id} onClick={() => revealSubagent(parent.id, child.id)}>
              <span className="min-w-0 flex-1 truncate">
                {sessionTitle(child)}
                {child.description && <span className="text-tertiary"> · {child.description}</span>}
              </span>
              <SubagentStatus child={child} />
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={showFinished} onCheckedChange={setShowFinishedSubagents}>
          {t('subagents.showFinished')}
        </DropdownMenuCheckboxItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
