import { Fragment } from 'react'
import { FolderOpenIcon } from 'lucide-react'
import { openProjectDialog } from '@renderer/app/actions'
import { AgentTile } from '@renderer/components/agents/agent-mark'
import { AmbientField, Clearing } from '@renderer/components/ambient-field'
import { rise } from '@renderer/lib/motion'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { Kbd } from '@renderer/components/ui/kbd'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { AgentStateLine } from '@renderer/features/agents/agent-state'
import { agentSubline, readiness } from '@renderer/features/agents/readiness'
import { TopBar } from '@renderer/features/shell/top-bar'
import { formatShortcut } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { useShallow } from 'zustand/react/shallow'

/** Shown when there are no projects. */
export function Welcome() {
  const agents = useAgentsStore(useShallow((s) => usableAgents(s.order, s.byId)))
  const loaded = useAgentsStore((s) => s.loaded)
  const title = rise(0)
  const action = rise(1)
  const heading = rise(2)

  return (
    <div className="relative isolate flex h-full flex-col">
      <AmbientField at="50% 38%" fade="ellipse 58% 62% at 50% 40%" phase={0.45} />
      <TopBar>
        <span />
      </TopBar>
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-7 pb-12">
        <div className="flex w-full max-w-[420px] flex-col items-center gap-7">
          <div
            className={cn(
              'relative flex flex-col items-center gap-2.5 text-center',
              title.className,
            )}
            style={title.style}
          >
            <Clearing />
            <h1 className="relative text-[30px] leading-[1.15] font-semibold tracking-[-0.025em]">
              OverBench
            </h1>
            <p className="relative text-sm leading-relaxed text-balance text-muted-foreground">
              Open a project to start working with an agent.
            </p>
          </div>
          <div className={action.className} style={action.style}>
            <Button
              size="lg"
              onClick={() => void openProjectDialog()}
              className="h-8 px-3 text-[13px]"
            >
              <FolderOpenIcon data-icon="inline-start" />
              Open project
              <Kbd className="ml-0.5 bg-transparent p-0 text-[11px] text-primary-foreground/55">
                {formatShortcut('Mod+O')}
              </Kbd>
            </Button>
          </div>
          <section aria-label="Agents" className="flex w-full flex-col gap-2">
            <h2
              className={cn('px-0.5 text-xs font-medium text-muted-foreground', heading.className)}
              style={heading.style}
            >
              Agents on this computer
            </h2>
            <div className="overflow-hidden rounded-xl bg-card shadow-card">
              {!loaded
                ? [0, 1, 2].map((i) => (
                    <div key={i} className="flex items-center gap-3 px-3.5 py-3">
                      <Skeleton className="size-[30px] rounded-[8px]" />
                      <div className="flex flex-1 flex-col gap-1.5">
                        <Skeleton className="h-3 w-24" />
                        <Skeleton className="h-2.5 w-40" />
                      </div>
                    </div>
                  ))
                : agents.map((status, i) => {
                    const r = readiness(status)
                    const row = rise(3 + i, 150)
                    return (
                      <Fragment key={status.id}>
                        {i > 0 && <div className="ml-14 h-(--hairline) bg-border-soft" />}
                        <div
                          className={cn('flex items-center gap-3 px-3.5 py-3', row.className)}
                          style={row.style}
                        >
                          <AgentTile
                            agent={status.id}
                            mono={r.kind === 'missing'}
                            size={30}
                            glyph={16}
                          />
                          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="font-medium">{status.name}</span>
                            <span
                              className={cn(
                                'truncate text-muted-foreground',
                                r.kind === 'missing' ? 'text-xs' : 'font-mono text-[11.5px]',
                              )}
                            >
                              {r.kind === 'missing' ? r.message : agentSubline(status)}
                            </span>
                          </div>
                          {r.kind === 'missing' ? (
                            r.url && (
                              <a
                                href={r.url}
                                target="_blank"
                                rel="noreferrer"
                                className={buttonVariants({ variant: 'outline', size: 'sm' })}
                              >
                                {r.action}
                              </a>
                            )
                          ) : (
                            <AgentStateLine status={status} />
                          )}
                        </div>
                      </Fragment>
                    )
                  })}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
