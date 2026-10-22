import { useState } from 'react'
import { BotIcon, ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import type { SessionSummary } from '@shared/agent-host'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { HeaderTools } from '@renderer/features/shell/header-tools'
import { NoDrag, TopBar } from '@renderer/features/shell/top-bar'
import {
  SessionDialogs,
  SessionMenuItems,
  type SessionDialog,
} from '@renderer/features/sidebar/session-menu'
import { agentName } from '@renderer/stores/agents'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'

/** The session's top bar: its title menu, the agent, and the project's git status. */
export function SessionHeader({ summary }: { summary: SessionSummary }) {
  const parent = useSessionsStore((s) => (summary.parentId ? s.byId[summary.parentId] : undefined))
  const [dialog, setDialog] = useState<SessionDialog>(null)
  const title = sessionTitle(summary)
  const subagent = summary.origin === 'subagent'

  return (
    <TopBar>
      {/* The title gives way last: the git status shrinks first (see HeaderTools). */}
      <NoDrag className="min-w-0 gap-0.5">
        {parent && (
          <>
            <Button
              variant="quiet"
              size="compact"
              className="min-w-0 max-w-[30%] shrink px-1.5"
              onClick={() => openSession(parent.id, parent.projectPath)}
            >
              <span className="truncate">{sessionTitle(parent)}</span>
            </Button>
            <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/70" />
          </>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="compact"
                title={`${title} · ${agentName(summary.agentId)}`}
                className="min-w-0 shrink gap-1.5 px-1.5 font-medium"
              />
            }
          >
            {subagent ? (
              <BotIcon data-icon="inline-start" className="text-muted-foreground" />
            ) : (
              <AgentMark agent={summary.agentId} size={14} className="shrink-0" />
            )}
            <span className="truncate">{title}</span>
            <ChevronDownIcon data-icon="inline-end" className="size-3 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <SessionMenuItems summary={summary} onDialog={setDialog} />
          </DropdownMenuContent>
        </DropdownMenu>
      </NoDrag>
      <span className="flex-1" />
      <HeaderTools projectPath={summary.projectPath} />
      <SessionDialogs summary={summary} dialog={dialog} onDialog={setDialog} />
    </TopBar>
  )
}
