import type { CSSProperties } from 'react'

const grid = (color: string, size: number): CSSProperties => ({
  backgroundImage: `radial-gradient(circle at center, ${color} ${size}px, transparent ${size + 0.5}px)`,
  backgroundSize: '20px 20px',
  backgroundPosition: '10px 10px',
})

// Longhands, not the `animation` shorthand: the shorthand also sets animation-play-state inline,
// which overrides the rule in globals.css that pauses the drift while the window is inactive.
const drift = (name: string, seconds: number, phase: number): CSSProperties => ({
  animationName: name,
  animationDuration: `${seconds}s`,
  animationTimingFunction: 'ease-in-out',
  animationDelay: `${-phase * seconds}s`,
  animationIterationCount: 'infinite',
  animationDirection: 'alternate',
})

/**
 * The ambient field behind Welcome and Project home: a dot grid that a soft light drifts across.
 * Every layer moves with `transform` only; the lit grid counter-moves inside the light, so the
 * dots stay in place and only the light travels.
 */
export function AmbientField({
  at = '50% 40%',
  fade = 'ellipse 62% 58% at 50% 42%',
  height = '100%',
  phase = 0,
}: {
  at?: string
  fade?: string
  height?: string
  /** Where in its cycle the drift starts, 0..1, so two screens do not move in step. */
  phase?: number
}) {
  const light = `radial-gradient(circle 280px at ${at}, #000, transparent)`
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 overflow-hidden"
      style={{
        height,
        maskImage: `radial-gradient(${fade}, #000 40%, transparent 100%)`,
      }}
    >
      <div className="absolute inset-0" style={grid('var(--ambient-dot)', 0.85)} />
      <div
        data-ambient-drift=""
        className="absolute inset-0 motion-reduce:transform-none"
        style={drift('ambient-x', 41, phase)}
      >
        <div
          data-ambient-drift=""
          className="absolute inset-0"
          style={{ ...drift('ambient-y', 29, phase), maskImage: light }}
        >
          <div
            className="absolute inset-0"
            style={{
              background: `radial-gradient(circle 280px at ${at}, var(--ambient-glow), transparent)`,
            }}
          />
          <div
            data-ambient-drift=""
            className="absolute inset-0"
            style={drift('ambient-y-reverse', 29, phase)}
          >
            <div
              data-ambient-drift=""
              className="absolute inset-0"
              style={{
                ...drift('ambient-x-reverse', 41, phase),
                ...grid('var(--ambient-dot-lit)', 1.15),
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

/** A wash of the surface color behind text, so no dot of the field sits in a word. */
export function Clearing({ inset = '-48px -96px' }: { inset?: string }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute"
      style={{
        inset,
        background: 'radial-gradient(closest-side, var(--background) 50%, transparent)',
      }}
    />
  )
}
