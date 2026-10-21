import { useEffect, useState } from 'react'
import { CheckIcon } from 'lucide-react'
import type { ImportableSession, Project } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { readiness } from '@renderer/features/agents/readiness'
import { shortAgo } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useShallow } from 'zustand/react/shallow'

interface AgentList {
  sessions: ImportableSession[]
  nextCursor: string | null
  loading: boolean
  error: string | null
}

/** Sessions the agents already have for this folder, such as ones started in the CLI. */
export function ImportSessionsDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const agents = useAgentsStore(
    useShallow((s) =>
      usableAgents(s.order, s.byId).filter(
        (a) => a.capabilities.listSessions && readiness(a).kind !== 'missing',
      ),
    ),
  )
  const [lists, setLists] = useState<Partial<Record<AgentId, AgentList>>>({})
  const [importing, setImporting] = useState<Record<string, 'busy' | 'done' | { error: string }>>(
    {},
  )

  // Requests only: the loading marker is set by whoever starts a load, never inside an effect.
  const request = (agentId: AgentId, cursor?: string) => {
    host('agents.listSessions', {
      agentId,
      projectPath: project.path,
      ...(cursor ? { cursor } : {}),
    })
      .then((page) =>
        setLists((l) => ({
          ...l,
          [agentId]: {
            sessions: [...(cursor ? (l[agentId]?.sessions ?? []) : []), ...page.sessions],
            nextCursor: page.nextCursor,
            loading: false,
            error: null,
          },
        })),
      )
      .catch((error: unknown) =>
        setLists((l) => ({
          ...l,
          [agentId]: {
            sessions: l[agentId]?.sessions ?? [],
            nextCursor: null,
            loading: false,
            error: errorMessage(error),
          },
        })),
      )
  }

  const loadMore = (agentId: AgentId, cursor: string) => {
    setLists((l) => ({
      ...l,
      [agentId]: {
        sessions: l[agentId]?.sessions ?? [],
        nextCursor: null,
        loading: true,
        error: null,
      },
    }))
    request(agentId, cursor)
  }

  // Each opening starts over, with the agents that can list sessions at that moment.
  const [shownOpen, setShownOpen] = useState(false)
  if (open !== shownOpen) {
    setShownOpen(open)
    if (open) {
      setLists({})
      setImporting({})
    }
  }

  useEffect(() => {
    if (!open) return
    for (const agent of agents) request(agent.id)
    // Reload only when the dialog opens; the agent list is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const importOne = async (agentId: AgentId, acpSessionId: string) => {
    setImporting((s) => ({ ...s, [acpSessionId]: 'busy' }))
    try {
      const summary = await host('sessions.import', {
        agentId,
        projectPath: project.path,
        acpSessionId,
      })
      useSessionsStore.getState().upsert(summary)
      setImporting((s) => ({ ...s, [acpSessionId]: 'done' }))
    } catch (error) {
      setImporting((s) => ({ ...s, [acpSessionId]: { error: errorMessage(error) } }))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(560px,80svh)] flex-col gap-4 sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Import sessions</DialogTitle>
          <DialogDescription>
            Sessions the agents already have for {project.name}, such as ones you started in a
            terminal. Imported sessions open with their full history.
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto px-1">
          {agents.length === 0 && (
            <p className="text-[13px] text-muted-foreground">
              No agent here can list its sessions.
            </p>
          )}
          {agents.map((agent) => {
            const list = lists[agent.id]
            return (
              <section key={agent.id} className="flex flex-col gap-1">
                <h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <AgentMark agent={agent.id} size={13} />
                  {agent.name}
                </h3>
                {list?.error ? (
                  <p className="text-[13px] text-destructive">{list.error}</p>
                ) : !list || (list.loading && !list.sessions.length) ? (
                  <div className="flex flex-col gap-1.5 py-1">
                    <Skeleton className="h-3 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                ) : list.sessions.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">No sessions for this folder.</p>
                ) : (
                  <ul className="flex flex-col gap-px">
                    {list.sessions.map((s) => {
                      const state = s.imported ? 'done' : importing[s.acpSessionId]
                      const failed = typeof state === 'object' ? state.error : null
                      return (
                        <li
                          key={s.acpSessionId}
                          className="flex h-8 items-center gap-2.5 rounded-lg px-2 hover:bg-accent"
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {s.title ?? 'Untitled session'}
                          </span>
                          {failed && (
                            <span
                              className="max-w-40 truncate text-xs text-destructive"
                              title={failed}
                            >
                              {failed}
                            </span>
                          )}
                          {s.updatedAt && (
                            <span className="text-[11.5px] text-muted-foreground tabular">
                              {shortAgo(Date.parse(s.updatedAt))}
                            </span>
                          )}
                          {state === 'done' ? (
                            <span className="inline-flex w-[62px] items-center justify-end gap-1 text-xs text-muted-foreground">
                              <CheckIcon className="size-3.5" />
                              Added
                            </span>
                          ) : (
                            <Button
                              variant="outline"
                              size="xs"
                              className="w-[62px]"
                              disabled={state === 'busy'}
                              onClick={() => void importOne(agent.id, s.acpSessionId)}
                            >
                              {state === 'busy' ? <Spinner className="size-3" /> : 'Import'}
                            </Button>
                          )}
                        </li>
                      )
                    })}
                    {list.nextCursor && (
                      <Button
                        variant="ghost"
                        size="xs"
                        className="self-start text-muted-foreground"
                        disabled={list.loading}
                        onClick={() => list.nextCursor && loadMore(agent.id, list.nextCursor)}
                      >
                        Show more
                      </Button>
                    )}
                  </ul>
                )}
              </section>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
