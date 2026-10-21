import { useState } from 'react'
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CornerDownRightIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { SessionSummary } from '@shared/agent-host'
import { closeSession, createSession } from '@renderer/app/actions'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { HeaderTools } from '@renderer/features/shell/header-tools'
import { NoDrag, TopBar } from '@renderer/features/shell/top-bar'
import { DeleteSessionDialog } from '@renderer/features/sidebar/session-row'
import { agentName, isInstalled, usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'

/** The session's top bar: its title menu, the agent, and the project's git status. */
export function SessionHeader({ summary }: { summary: SessionSummary }) {
  const parent = useSessionsStore((s) => (summary.parentId ? s.byId[summary.parentId] : undefined))
  const agents = useAgentsStore(useShallow((s) => usableAgents(s.order, s.byId)))
  const [deleting, setDeleting] = useState(false)
  const title = sessionTitle(summary)
  const subagent = summary.origin === 'subagent'

  return (
    <TopBar>
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
                className="min-w-0 shrink gap-1 px-1.5 font-medium"
              />
            }
          >
            {subagent && <BotIcon data-icon="inline-start" className="text-muted-foreground" />}
            <span className="truncate">{title}</span>
            <ChevronDownIcon data-icon="inline-end" className="size-3 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-52">
            {!subagent && (
              <>
                <DropdownMenuGroup>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <CornerDownRightIcon />
                      New sub-session
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-48">
                      {agents.map((agent) => (
                        <DropdownMenuItem
                          key={agent.id}
                          disabled={!isInstalled(agent)}
                          onClick={() =>
                            void createSession(agent.id, summary.projectPath, summary.id)
                          }
                        >
                          <AgentMark agent={agent.id} size={14} mono={!isInstalled(agent)} />
                          {agent.name}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => void closeSession(summary.id)}>
                <XIcon />
                Close
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
                <Trash2Icon />
                Delete…
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* In a narrow window the name gives way first, down to the mark alone. */}
        <span
          className="ml-1 inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
          title={agentName(summary.agentId)}
        >
          <AgentMark agent={summary.agentId} size={13} />
          <span className="truncate">{agentName(summary.agentId)}</span>
        </span>
      </NoDrag>
      <span className="flex-1" />
      <HeaderTools projectPath={summary.projectPath} />
      <DeleteSessionDialog
        sessionId={summary.id}
        title={title}
        open={deleting}
        onOpenChange={setDeleting}
      />
    </TopBar>
  )
}
