// Counters for perf runs (--overbench-perf). tools/perf/measure.mjs reads them over the Chrome
// DevTools Protocol from `window.__overbenchPerf`; without the flag nothing here runs.
import { useThreadsStore } from '@renderer/stores/threads'
import { createFrameCounter } from './perf-counter'

export interface SwitchTiming {
  sessionId: string
  /** From the click to the first frame painted with the session's thread. */
  ms: number
}

const enabled = typeof window !== 'undefined' && window.overbench.perf
let pendingSwitch: { sessionId: string; start: number } | null = null
const switches: SwitchTiming[] = []

/** Called when the user picks another session. */
export function markSwitchStart(sessionId: string): void {
  if (enabled) pendingSwitch = { sessionId, start: performance.now() }
}

/** Called once a session shows its thread; records the switch after that frame is painted. */
export function markThreadShown(sessionId: string): void {
  const pending = pendingSwitch
  if (!enabled || pending?.sessionId !== sessionId) return
  pendingSwitch = null
  // The task after the next animation frame runs once that frame has been painted.
  requestAnimationFrame(() =>
    setTimeout(() => switches.push({ sessionId, ms: performance.now() - pending.start }), 0),
  )
}

export function installPerfCounters(): void {
  if (!enabled) return
  const counter = createFrameCounter()
  useThreadsStore.subscribe(() => {
    if (counter.count()) requestAnimationFrame(() => counter.endFrame())
  })
  Object.assign(window, {
    __overbenchPerf: {
      frames: () => counter.read(),
      switches: () => [...switches],
      reset: () => {
        counter.reset()
        switches.length = 0
      },
    },
  })
}
