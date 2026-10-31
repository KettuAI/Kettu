import { harnessOf, type AgentId } from '@shared/thread'
import { cn } from '@renderer/lib/utils'
import { AGENT_MARKS } from './marks'

interface AgentMarkProps {
  agent: AgentId
  size?: number
  /** One color, `currentColor`: an agent that is not installed. */
  mono?: boolean
  className?: string
}

/**
 * The mark of the agent's harness in its own colors, the only brand colors in the interface; the
 * agents of one harness share it.
 */
export function AgentMark({ agent, size = 14, mono = false, className }: AgentMarkProps) {
  const { viewBox, Body } = AGENT_MARKS[harnessOf(agent)]
  return (
    <svg
      width={size}
      height={size}
      aria-hidden
      viewBox={viewBox}
      className={cn('block shrink-0', className)}
    >
      <Body mono={mono} />
    </svg>
  )
}

/** The mark on a 32 px tile, for agent cards. */
export function AgentTile({
  agent,
  mono,
  size = 32,
  glyph = 17,
}: {
  agent: AgentId
  mono?: boolean
  size?: number
  glyph?: number
}) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className="grid shrink-0 place-items-center rounded-lg bg-tile text-icon shadow-[inset_0_0_var(--hairline)_var(--border-subtle)]"
    >
      <AgentMark agent={agent} size={glyph} mono={mono} />
    </span>
  )
}
