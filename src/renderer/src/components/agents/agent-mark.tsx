import { useContext } from 'react'
import type { AgentColor } from '@shared/settings'
import { harnessOf, type AgentId } from '@shared/thread'
import { cn } from '@renderer/lib/utils'
import { agentsOn, useAgentsStore } from '@renderer/stores/agents'
import { AgentMarkHost } from './agent-mark-host'
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

/** The dot its host gives an added agent; none for a harness's default agent. */
function useAgentDot(agent: AgentId, hostId: string | null | undefined): AgentColor | null {
  const scoped = useContext(AgentMarkHost)
  const host = hostId === undefined ? scoped : hostId
  return useAgentsStore((s) => agentsOn(s, host).byId[agent]?.color ?? null)
}

/** The ring matches the surface unless an ancestor sets `--agent-dot-ring`. */
function AgentDot({ color, size }: { color: AgentColor; size: number }) {
  const diameter = Math.max(3, Math.min(7, Math.round(size / 4)))
  const ring = Math.min(1.5, diameter / 4)
  return (
    <span
      aria-hidden
      style={{
        backgroundColor: `var(--agent-${color})`,
        width: diameter,
        height: diameter,
        right: -ring,
        bottom: -ring,
        boxShadow: `0 0 0 ${ring}px var(--agent-dot-ring,var(--bg-surface))`,
      }}
      className="absolute rounded-full"
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
      <AgentDot color={color} size={size} />
    </span>
  )
}

/** A flat avatar with consistent mark and dot proportions across sizes. */
export function AgentTile({
  agent,
  mono,
  size = 32,
  hostId,
  dot,
}: {
  agent: AgentId
  mono?: boolean
  size?: number
  hostId?: string | null
  dot?: AgentColor | null
}) {
  const own = useAgentDot(agent, hostId)
  const color = dot === undefined ? own : dot
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className="relative grid shrink-0 place-items-center text-icon"
    >
      <AgentMark agent={agent} size={Math.round(size * 0.75)} mono={mono} dot={null} />
      {color && <AgentDot color={color} size={size} />}
    </span>
  )
}
