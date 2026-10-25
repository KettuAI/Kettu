import { useEffect, useState, useSyncExternalStore } from 'react'

/** What a refresh button shows: the resting icon, a turn, or a check after it worked. */
export type RefreshPhase = 'idle' | 'turning' | 'done'

/** One turn of `animate-spin`. */
export const TURN_MS = 1000

/** How long a successful refresh keeps its check. */
const DONE_MS = 2000

/** The time to the end of the turn in progress; a whole turn when nothing has elapsed. */
export function turnRemaining(elapsedMs: number): number {
  return TURN_MS - (elapsedMs % TURN_MS)
}

export interface RefreshTurn {
  getPhase(): RefreshPhase
  subscribe(changed: () => void): () => void
  /** Work that runs for another reason, such as a scan the user did not start. */
  setBusy(busy: boolean): void
  run<T>(action: () => Promise<T>): Promise<T>
  dispose(): void
}

/**
 * The timing behind `useRefresh`, apart from React so it can be tested with fake timers. A turn
 * outlives the answer, a success holds a check for two seconds, and work reported through
 * `setBusy` turns the icon without a check.
 */
export function createRefreshTurn(): RefreshTurn {
  let phase: RefreshPhase = 'idle'
  let busy = false
  let busySince = 0
  let running = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let doneTimer: ReturnType<typeof setTimeout> | undefined
  let turnTimer: ReturnType<typeof setTimeout> | undefined
  let turnEnded: (() => void) | null = null
  const listeners = new Set<() => void>()

  function setPhase(next: RefreshPhase): void {
    if (phase === next) return
    phase = next
    for (const listener of listeners) listener()
  }

  function clearIdle(): void {
    clearTimeout(idleTimer)
    idleTimer = undefined
  }

  /** Stops at the end of the turn that began at `since`, unless work holds the icon. */
  function settleIdle(since: number): void {
    clearIdle()
    idleTimer = setTimeout(
      () => {
        idleTimer = undefined
        if (!running && !busy) setPhase('idle')
      },
      turnRemaining(Date.now() - since),
    )
  }

  /** Resolves at the end of the turn that began at `since`. */
  function waitTurn(since: number): Promise<void> {
    return new Promise((resolve) => {
      turnEnded = resolve
      turnTimer = setTimeout(
        () => {
          turnTimer = undefined
          turnEnded = null
          resolve()
        },
        turnRemaining(Date.now() - since),
      )
    })
  }

  function setBusy(next: boolean): void {
    if (next === busy) return
    busy = next
    if (next) {
      busySince = Date.now()
      clearIdle()
      if (!running) setPhase('turning')
      return
    }
    if (!running) settleIdle(busySince)
  }

  async function run<T>(action: () => Promise<T>): Promise<T> {
    clearIdle()
    clearTimeout(doneTimer)
    doneTimer = undefined
    running = true
    const startedAt = Date.now()
    setPhase('turning')
    let result: T
    try {
      result = await action()
    } catch (error) {
      await waitTurn(startedAt)
      running = false
      setPhase(busy ? 'turning' : 'idle')
      throw error
    }
    await waitTurn(startedAt)
    running = false
    setPhase('done')
    doneTimer = setTimeout(() => {
      doneTimer = undefined
      if (!running && !busy) setPhase('idle')
    }, DONE_MS)
    return result
  }

  function dispose(): void {
    clearIdle()
    clearTimeout(doneTimer)
    doneTimer = undefined
    clearTimeout(turnTimer)
    turnTimer = undefined
    turnEnded?.()
    turnEnded = null
  }

  function subscribe(changed: () => void): () => void {
    listeners.add(changed)
    return () => {
      listeners.delete(changed)
    }
  }

  return { getPhase: () => phase, subscribe, setBusy, run, dispose }
}

/**
 * A refresh button's phase: `run` turns the icon for at least one turn and then shows the result,
 * while `busy` turns it for work that runs for another reason and stops without a check.
 */
export function useRefresh({ busy = false }: { busy?: boolean } = {}): {
  run: <T>(action: () => Promise<T>) => Promise<T>
  phase: RefreshPhase
} {
  const [turn] = useState(createRefreshTurn)
  const phase = useSyncExternalStore(turn.subscribe, turn.getPhase)
  useEffect(() => {
    turn.setBusy(busy)
  }, [turn, busy])
  useEffect(() => () => turn.dispose(), [turn])
  return { run: turn.run, phase }
}
