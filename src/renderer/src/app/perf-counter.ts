export interface FrameCounts {
  /** Frames in which the thread store changed at least once. */
  frames: number
  /** Thread store changes in all those frames. */
  updates: number
  /** The most changes within one frame. */
  maxPerFrame: number
}

/** Counts store changes per animation frame; `endFrame` closes the frame `count` opened. */
export function createFrameCounter() {
  let current = 0
  let counts: FrameCounts = { frames: 0, updates: 0, maxPerFrame: 0 }
  return {
    /** Returns true when this change opened a frame, so the caller schedules `endFrame`. */
    count(): boolean {
      current += 1
      return current === 1
    },
    endFrame(): void {
      if (current === 0) return
      counts = {
        frames: counts.frames + 1,
        updates: counts.updates + current,
        maxPerFrame: Math.max(counts.maxPerFrame, current),
      }
      current = 0
    },
    read(): FrameCounts {
      return counts
    },
    reset(): void {
      current = 0
      counts = { frames: 0, updates: 0, maxPerFrame: 0 }
    },
  }
}
