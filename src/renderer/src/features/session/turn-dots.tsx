import { cn } from 'cn'
import { BY_PHASE, CELLS, turnDotStyles, type RunningPhase } from './turn-dot-patterns'

/**
 * The running turn's mark: nine dots in the fox's orange acting out the phase. Each dot only
 * changes its opacity, on its own delay into the phase's loop; reduced motion holds the frame the
 * loop starts on.
 */
export function TurnDots({ phase, className }: { phase: RunningPhase; className?: string }) {
  const styles = turnDotStyles(phase)
  return (
    <svg
      key={BY_PHASE[phase]}
      data-turn-dots
      viewBox="0 0 12 12"
      aria-hidden
      className={cn(
        'size-3 shrink-0 animate-in fill-current text-(--thread-fox) animation-duration-(--duration-base) fade-in',
        className,
      )}
    >
      {CELLS.map(([x, y], i) => (
        <circle key={`${x}${y}`} cx={2 + x * 4} cy={2 + y * 4} r={1.4} style={styles[i]} />
      ))}
    </svg>
  )
}
