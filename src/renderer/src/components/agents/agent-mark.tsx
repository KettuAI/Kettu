import type { AgentColor } from '@shared/settings'
import { harnessOf, type AgentId } from '@shared/thread'
import { cn } from '@renderer/lib/utils'
import { agentsOn, useAgentsStore } from '@renderer/stores/agents'
import { useHostScope } from '@renderer/stores/host-scope'
import { AGENT_MARKS } from './marks'

interface AgentMarkProps {
  agent: AgentId
  size?: number
  /** One color, `currentColor`: an agent that is not installed. */
  mono?: boolean
  className?: string
  /** The host the agent is on, where the mark shows outside that host's scope, as a session's. */
  hostId?: string | null
  /** The dot to draw, in place of the one the agent's host reports; null for none. */
  dot?: AgentColor | null
}

/**
 * The dot its host gives an added agent; none for a harness's default agent. Without a host, the
 * one of the section showing the mark: this computer's unless Settings shows another host.
 */
function useAgentDot(agent: AgentId, hostId: string | null | undefined): AgentColor | null {
  const { useAgentsStore: useScoped } = useHostScope()
  const scoped = useScoped((s) => s.byId[agent]?.color ?? null)
  const onHost = useAgentsStore((s) =>
    hostId === undefined ? null : (agentsOn(s, hostId).byId[agent]?.color ?? null),
  )
  return hostId === undefined ? scoped : onHost
}

/**
 * The 7 px dot at the bottom right that tells an added agent from its harness's default. Its ring
 * is the color behind the mark: the surface unless an ancestor sets `--agent-dot-ring`.
 */
function AgentDot({ color }: { color: AgentColor }) {
  return (
    <span
      aria-hidden
      style={{ backgroundColor: `var(--agent-${color})` }}
      className="absolute -right-0.5 -bottom-0.5 size-1.75 rounded-full shadow-[0_0_0_1.5px_var(--agent-dot-ring,var(--bg-surface))]"
    />
  )
}

/**
 * The mark of the agent's harness in its own colors, the only brand colors in the interface; the
 * agents of one harness share it, an added agent's with its dot.
 */
export function AgentMark({
  agent,
  size = 14,
  mono = false,
  className,
  hostId,
  dot,
}: AgentMarkProps) {
  const { viewBox, Body } = AGENT_MARKS[harnessOf(agent)]
  const own = useAgentDot(agent, hostId)
  const color = dot === undefined ? own : dot
  const mark = (
    <svg
      width={size}
      height={size}
      aria-hidden
      viewBox={viewBox}
      className={cn('block shrink-0', !color && className)}
    >
      <Body mono={mono} />
    </svg>
  )
  if (!color) return mark
  return (
    <span aria-hidden className={cn('relative block shrink-0', className)}>
      {mark}
      <AgentDot color={color} />
    </span>
  )
}

/** The mark on a 32 px tile, for agent cards. */
export function AgentTile({
  agent,
  mono,
  size = 32,
  glyph = 17,
  hostId,
  dot,
}: {
  agent: AgentId
  mono?: boolean
  size?: number
  glyph?: number
  hostId?: string | null
  dot?: AgentColor | null
}) {
  const own = useAgentDot(agent, hostId)
  const color = dot === undefined ? own : dot
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className="relative grid shrink-0 place-items-center rounded-lg bg-tile text-icon shadow-[inset_0_0_var(--hairline)_var(--border-subtle)]"
    >
      <AgentMark agent={agent} size={glyph} mono={mono} dot={null} />
      {color && <AgentDot color={color} />}
    </span>
  )
}
