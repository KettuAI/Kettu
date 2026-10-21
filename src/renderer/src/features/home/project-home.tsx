import { useMemo, useState } from 'react'
import { CircleAlertIcon, HistoryIcon } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { AgentStatus, Project } from '@shared/agent-host'
import { createSession } from '@renderer/app/actions'
import { AgentMark, AgentTile } from '@renderer/components/agents/agent-mark'
import { AmbientField, Clearing } from '@renderer/components/ambient-field'
import { rise } from '@renderer/lib/motion'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { AgentStateLine } from '@renderer/features/agents/agent-state'
import { agentSubline, readiness } from '@renderer/features/agents/readiness'
import { HeaderTools } from '@renderer/features/shell/header-tools'
import { TopBar } from '@renderer/features/shell/top-bar'
import { shortAgo } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { agentName, usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { isActive, sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import { ImportSessionsDialog } from './import-sessions'

/** Shown when a project is selected but no session is. */
export function ProjectHome({ project }: { project: Project }) {
  const agents = useAgentsStore(useShallow((s) => usableAgents(s.order, s.byId)))
  const [importing, setImporting] = useState(false)
  const header = rise(0)

  return (
    <div className="relative isolate flex h-full flex-col">
      <AmbientField at="50% 30%" fade="ellipse 70% 100% at 50% 0%" height="470px" phase={0.3} />
      <TopBar className="relative">
        <span className="flex-1" />
        <HeaderTools projectPath={project.path} />
      </TopBar>
      <div className="relative min-h-0 flex-1 overflow-y-auto px-7 py-9 [scrollbar-gutter:stable]">
        <div className="mx-auto flex max-w-[712px] flex-col gap-9">
          <div
            className={cn('flex flex-wrap items-end gap-3', header.className)}
            style={header.style}
          >
            <div className="relative flex min-w-0 flex-1 flex-col gap-1.5">
              <Clearing inset="-24px -40px" />
              <h1 className="relative text-[22px] leading-tight font-semibold tracking-[-0.015em]">
                {project.name}
              </h1>
              <span
                className="relative truncate font-mono text-xs text-muted-foreground"
                data-selectable=""
              >
                {project.path}
              </span>
            </div>
            <Button variant="outline" size="sm" onClick={() => setImporting(true)}>
              <HistoryIcon data-icon="inline-start" />
              Import sessions
            </Button>
          </div>

          {project.missing ? (
            <div className="flex items-center gap-2 rounded-xl bg-card px-3.5 py-3 text-[13px] shadow-card">
              <CircleAlertIcon className="size-4 text-destructive" />
              This folder no longer exists. Its sessions stay listed until it comes back.
            </div>
          ) : (
            <section aria-label="Start a session" className="flex flex-col gap-2.5">
              <h2 className="text-xs font-medium text-muted-foreground">Start a session</h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
                {agents.map((status, i) => (
                  <AgentCard key={status.id} status={status} project={project} index={i} />
                ))}
              </div>
            </section>
          )}

          <RecentSessions projectPath={project.path} />
        </div>
      </div>
      <ImportSessionsDialog project={project} open={importing} onOpenChange={setImporting} />
    </div>
  )
}

function AgentCard({
  status,
  project,
  index,
}: {
  status: AgentStatus
  project: Project
  index: number
}) {
  const r = readiness(status)
  const entry = rise(1 + index, 120)
  const missing = r.kind === 'missing'
  return (
    <button
      type="button"
      disabled={missing}
      onClick={() => void createSession(status.id, project.path)}
      style={entry.style}
      className={cn(
        // Card hover: rise 1 px, a strong ring, the sm shadow and a soft light from the bottom edge.
        'group/card relative flex flex-col items-start gap-3.5 overflow-hidden rounded-xl bg-card p-3.5 text-left shadow-card outline-none',
        'transition-[transform,box-shadow] duration-(--duration-fast) ease-out-expo',
        'before:pointer-events-none before:absolute before:inset-0 before:bg-[radial-gradient(ellipse_90%_70%_at_50%_100%,var(--card-glow),transparent_70%)] before:opacity-0 before:transition-opacity before:duration-(--duration-fast)',
        'enabled:hover:-translate-y-px enabled:hover:shadow-[inset_0_0_0_var(--hairline)_var(--border-strong),var(--highlight),var(--elevation-sm)] enabled:hover:before:opacity-100',
        'motion-reduce:enabled:hover:translate-y-0',
        'focus-visible:ring-3 focus-visible:ring-ring/50 enabled:active:translate-y-0 disabled:cursor-default',
        entry.className,
      )}
    >
      <AgentTile agent={status.id} mono={missing} />
      <span className="relative flex w-full min-w-0 flex-col gap-[3px]">
        <span className="text-sm font-medium">{status.name}</span>
        <span className="truncate font-mono text-[11.5px] text-muted-foreground">
          {missing ? r.message : agentSubline(status)}
        </span>
      </span>
      {missing ? (
        r.url ? (
          <a
            href={r.url}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
            className={cn(buttonVariants({ variant: 'outline', size: 'xs' }), 'relative')}
          >
            {r.action}
          </a>
        ) : null
      ) : (
        <AgentStateLine status={status} className="relative" />
      )}
    </button>
  )
}

function RecentSessions({ projectPath }: { projectPath: string }) {
  const now = useNow()
  const summaries = useSessionsStore(
    useShallow((s) =>
      Object.values(s.byId).filter((x) => x.projectPath === projectPath && x.parentId === null),
    ),
  )
  const recent = useMemo(
    () => [...summaries].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12),
    [summaries],
  )
  if (!recent.length) return null
  return (
    <section aria-label="Recent sessions" className="flex flex-col gap-1.5">
      <h2 className="text-xs font-medium text-muted-foreground">Recent sessions</h2>
      <ul className="-mx-2 flex flex-col gap-px">
        {recent.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => openSession(s.id, s.projectPath)}
              className="flex h-[34px] w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors duration-(--duration-fast) outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <AgentMark agent={s.agentId} size={14} />
              <span className="min-w-0 flex-1 truncate">{sessionTitle(s)}</span>
              {s.attention === 'permission' ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-attention-text">
                  <span aria-hidden className="size-1.5 rounded-full bg-attention" />
                  Waiting for you
                </span>
              ) : s.attention === 'error' || s.status === 'failed' ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-destructive">
                  <CircleAlertIcon strokeWidth={2} className="size-[13px]" />
                  Failed
                </span>
              ) : isActive(s) ? (
                <span className="text-xs text-muted-foreground">Working</span>
              ) : (
                <span className="text-xs text-muted-foreground">{agentName(s.agentId)}</span>
              )}
              <span className="w-12 text-right text-[11.5px] text-muted-foreground tabular">
                {shortAgo(s.updatedAt, now)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
