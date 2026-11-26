import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OutlineEntry, OutlineTitle } from '@shared/agent-host'
import type { ThreadEntry } from '@shared/thread'
import {
  beginOutlineFetch,
  commitCachedOutline,
  forgetOutline,
  getCachedOutline,
  invalidateOutlines,
  MAX_CACHED_OUTLINES,
  outlineCacheEpoch,
  patchCachedOutlineTitles,
  touchCachedOutline,
} from './outline-cache'

const hostMock = vi.fn()
let outlineSummariesSetting = true

// Minimal React hook harness so `useOutline` runs with real mount, rerender, unmount, effect
// cleanup, and `useSyncExternalStore` semantics under Vitest's node environment.
interface EffectSlot {
  deps: readonly unknown[] | undefined
  create: () => void | (() => void)
  cleanup?: (() => void) | void
}

interface SubSlot {
  subscribe: (listener: () => void) => () => void
  unsubscribe?: () => void
}

interface HookInstance {
  cursor: number
  slots: unknown[]
  effects: (EffectSlot | undefined)[]
  pendingEffects: number[]
  subs: Map<number, SubSlot>
  mounted: boolean
  renderFn: () => unknown
  lastResult: unknown
}

let activeInstance: HookInstance | null = null

function depsChanged(
  prev: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined,
): boolean {
  if (!prev || !next || prev.length !== next.length) return true
  for (let i = 0; i < prev.length; i++) if (!Object.is(prev[i], next[i])) return true
  return false
}

function flushInstance(inst: HookInstance): void {
  const queue = inst.pendingEffects.splice(0)
  for (const idx of queue) {
    const slot = inst.effects[idx]
    if (!slot) continue
    if (typeof slot.cleanup === 'function') slot.cleanup()
    slot.cleanup = slot.create()
  }
}

function runRender<T>(inst: HookInstance): T {
  inst.cursor = 0
  const prev = activeInstance
  activeInstance = inst
  try {
    inst.lastResult = inst.renderFn()
  } finally {
    activeInstance = prev
  }
  flushInstance(inst)
  return inst.lastResult as T
}

function mountHook<T>(renderFn: () => T) {
  const inst: HookInstance = {
    cursor: 0,
    slots: [],
    effects: [],
    pendingEffects: [],
    subs: new Map(),
    mounted: true,
    renderFn,
    lastResult: undefined,
  }
  runRender<T>(inst)
  return {
    get current(): T {
      return inst.lastResult as T
    },
    rerender(nextRender?: () => T): T {
      if (nextRender) inst.renderFn = nextRender
      return runRender<T>(inst)
    },
    unmount(): void {
      inst.mounted = false
      for (const sub of inst.subs.values()) sub.unsubscribe?.()
      inst.subs.clear()
      for (const slot of inst.effects) {
        if (typeof slot?.cleanup === 'function') slot.cleanup()
      }
      inst.effects.length = 0
    },
  }
}

vi.mock('react', () => ({
  useCallback: <T extends (...args: never[]) => unknown>(fn: T, deps: readonly unknown[]): T => {
    const inst = activeInstance!
    const idx = inst.cursor++
    const prev = inst.slots[idx] as { fn: T; deps: readonly unknown[] } | undefined
    if (prev && !depsChanged(prev.deps, deps)) return prev.fn
    inst.slots[idx] = { fn, deps }
    return fn
  },
  useMemo: <T>(factory: () => T, deps: readonly unknown[]): T => {
    const inst = activeInstance!
    const idx = inst.cursor++
    const prev = inst.slots[idx] as { value: T; deps: readonly unknown[] } | undefined
    if (prev && !depsChanged(prev.deps, deps)) return prev.value
    const value = factory()
    inst.slots[idx] = { value, deps }
    return value
  },
  useEffect: (create: () => void | (() => void), deps?: readonly unknown[]): void => {
    const inst = activeInstance!
    const idx = inst.cursor++
    const prev = inst.effects[idx]
    if (!prev || depsChanged(prev.deps, deps)) {
      inst.effects[idx] = { deps, create, cleanup: prev?.cleanup }
      inst.pendingEffects.push(idx)
    }
  },
  useSyncExternalStore: <T>(
    subscribe: (listener: () => void) => () => void,
    getSnapshot: () => T,
  ): T => {
    const inst = activeInstance!
    const idx = inst.cursor++
    const existing = inst.subs.get(idx)
    if (!existing || existing.subscribe !== subscribe) {
      existing?.unsubscribe?.()
      const unsubscribe = subscribe(() => {
        if (inst.mounted) runRender(inst)
      })
      inst.subs.set(idx, { subscribe, unsubscribe })
    }
    return getSnapshot()
  },
}))

vi.mock('@renderer/lib/host', () => ({
  host: (...args: unknown[]) => hostMock(...args),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}))

vi.mock('@renderer/stores/settings', () => ({
  useSettingsStore: {
    getState: () => ({ settings: { thread: { outlineSummaries: outlineSummariesSetting } } }),
  },
}))

interface MockReplica {
  state: { order: string[]; byId: Record<string, ThreadEntry> } | null
  older: number | null
}

const mockStoreListeners = new Set<() => void>()
let mockReplicas: Record<string, MockReplica> = {}

function setMockReplica(sessionId: string, replica: MockReplica | undefined): void {
  const next = { ...mockReplicas }
  if (replica) next[sessionId] = replica
  else delete next[sessionId]
  mockReplicas = next
  for (const listener of [...mockStoreListeners]) listener()
}

vi.mock('@renderer/stores/threads', () => {
  const useThreadsStore = Object.assign(
    <T>(selector: (state: { replicas: Record<string, MockReplica> }) => T): T => {
      const inst = activeInstance!
      const idx = inst.cursor++
      if (!inst.subs.has(idx)) {
        const listener = () => {
          if (inst.mounted) runRender(inst)
        }
        mockStoreListeners.add(listener)
        inst.subs.set(idx, {
          subscribe: () => () => undefined,
          unsubscribe: () => mockStoreListeners.delete(listener),
        })
      }
      return selector({ replicas: mockReplicas })
    },
    {
      getState: () => ({ replicas: mockReplicas }),
    },
  )
  return { useThreadsStore }
})

function userEntry(id: string, text: string): ThreadEntry {
  return { kind: 'user', id, content: [{ type: 'text', text }] }
}

function outlineEntry(
  pos: number,
  entryId: string,
  text: string,
  title: string | null = null,
): OutlineEntry {
  return { pos, entryId, text, title }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('outline-cache', () => {
  beforeEach(() => {
    invalidateOutlines()
  })

  it('bounds entries with LRU eviction and promotes touched sessions', () => {
    for (let i = 0; i < MAX_CACHED_OUTLINES; i++) {
      commitCachedOutline(`s-${i}`, [outlineEntry(0, `u-${i}`, `msg ${i}`)])
    }
    // Touch s-0 so s-1 becomes the oldest entry.
    touchCachedOutline('s-0')
    commitCachedOutline('s-new', [outlineEntry(0, 'u-new', 'newest')])

    expect(getCachedOutline('s-0')).not.toBeNull()
    expect(getCachedOutline('s-1')).toBeNull()
    expect(getCachedOutline('s-new')).not.toBeNull()
  })

  it('drops stale in-flight fetches after invalidation or newer commits', () => {
    const olderTicket = beginOutlineFetch('s1')
    const newerTicket = beginOutlineFetch('s1')

    expect(commitCachedOutline('s1', [outlineEntry(0, 'u2', 'new')], newerTicket)).toBe(true)
    expect(commitCachedOutline('s1', [outlineEntry(0, 'u1', 'old')], olderTicket)).toBe(false)
    expect(getCachedOutline('s1')?.[0]?.entryId).toBe('u2')

    const invalidatedTicket = beginOutlineFetch('s1')
    forgetOutline('s1')
    expect(getCachedOutline('s1')).toBeNull()
    expect(commitCachedOutline('s1', [outlineEntry(0, 'u3', 'stale')], invalidatedTicket)).toBe(
      false,
    )
    expect(getCachedOutline('s1')).toBeNull()
  })

  it('preserves patched titles when a concurrent outline response resolves slightly later', () => {
    const ticket = beginOutlineFetch('s1')
    commitCachedOutline('s1', [outlineEntry(0, 'u1', 'first line', null)])
    const epoch = outlineCacheEpoch('s1')
    expect(patchCachedOutlineTitles('s1', [{ pos: 0, title: 'Generated title' }], epoch)).toBe(true)

    commitCachedOutline('s1', [outlineEntry(0, 'u1', 'first line', null)], ticket)
    expect(getCachedOutline('s1')?.[0]?.title).toBe('Generated title')
  })
})

describe('useOutline', () => {
  beforeEach(() => {
    invalidateOutlines()
    hostMock.mockReset()
    mockReplicas = {}
    mockStoreListeners.clear()
    outlineSummariesSetting = true
  })

  afterEach(() => {
    invalidateOutlines()
    vi.restoreAllMocks()
  })

  it('reuses cached outline across unmount/remount switches without re-querying sessions.outline', async () => {
    const { useOutline } = await import('./use-outline')
    setMockReplica('s1', {
      older: 10,
      state: { order: ['u2'], byId: { u2: userEntry('u2', 'second') } },
    })
    setMockReplica('s2', {
      older: null,
      state: { order: ['b1'], byId: { b1: userEntry('b1', 'other session') } },
    })

    hostMock.mockImplementation((method: string, params: { sessionId: string }) => {
      if (method === 'sessions.outline' && params.sessionId === 's1') {
        return Promise.resolve({
          entries: [
            outlineEntry(0, 'u1', 'first', 'First title'),
            outlineEntry(10, 'u2', 'second'),
          ],
        })
      }
      if (method === 'sessions.outline' && params.sessionId === 's2') {
        return Promise.resolve({
          entries: [outlineEntry(0, 'b1', 'other session')],
        })
      }
      return Promise.resolve({ entries: [], titles: [] })
    })

    // First visit to s1 fetches once.
    const first = mountHook(() => useOutline('s1'))
    await flushMicrotasks()
    expect(hostMock).toHaveBeenCalledTimes(1)
    expect(first.current.rows).toEqual([
      { entryId: 'u1', pos: 0, label: 'First title', titled: true },
      { entryId: 'u2', pos: 10, label: 'second', titled: false },
    ])

    // Switch to s2, then back to s1.
    first.unmount()
    const second = mountHook(() => useOutline('s2'))
    await flushMicrotasks()
    expect(hostMock).toHaveBeenCalledTimes(2)
    second.unmount()

    // Returning to s1 uses cached outline immediately and does not call sessions.outline again.
    const backToS1 = mountHook(() => useOutline('s1'))
    await flushMicrotasks()
    expect(hostMock).toHaveBeenCalledTimes(2)
    expect(backToS1.current.rows).toEqual([
      { entryId: 'u1', pos: 0, label: 'First title', titled: true },
      { entryId: 'u2', pos: 10, label: 'second', titled: false },
    ])
    backToS1.unmount()
  })

  it('shows cached plus unlisted replica entries immediately and refreshes in the background', async () => {
    const { useOutline } = await import('./use-outline')
    commitCachedOutline('s1', [outlineEntry(0, 'u1', 'first')])
    setMockReplica('s1', {
      older: null,
      state: {
        order: ['u1', 'u2'],
        byId: { u1: userEntry('u1', 'first'), u2: userEntry('u2', 'brand new') },
      },
    })

    let resolveOutline!: (value: { entries: OutlineEntry[] }) => void
    hostMock.mockImplementation((method: string) => {
      if (method === 'sessions.outline') {
        return new Promise((resolve) => {
          resolveOutline = resolve
        })
      }
      return Promise.resolve()
    })

    const hook = mountHook(() => useOutline('s1'))
    // Immediately shows cached u1 + unlisted replica u2 while background refresh is in flight.
    expect(hook.current.rows).toEqual([
      { entryId: 'u1', pos: 0, label: 'first', titled: false },
      { entryId: 'u2', pos: null, label: 'brand new', titled: false },
    ])
    expect(hostMock).toHaveBeenCalledWith('sessions.outline', { sessionId: 's1' })

    resolveOutline({
      entries: [outlineEntry(0, 'u1', 'first'), outlineEntry(5, 'u2', 'brand new')],
    })
    await flushMicrotasks()

    expect(hook.current.rows).toEqual([
      { entryId: 'u1', pos: 0, label: 'first', titled: false },
      { entryId: 'u2', pos: 5, label: 'brand new', titled: false },
    ])
    hook.unmount()
  })

  it('refreshes when a loaded user entry is removed (e.g. after revert)', async () => {
    const { useOutline } = await import('./use-outline')
    commitCachedOutline('s1', [outlineEntry(0, 'u1', 'first'), outlineEntry(5, 'u2', 'reverted')])
    setMockReplica('s1', {
      older: null,
      state: {
        order: ['u1'],
        byId: { u1: userEntry('u1', 'first') },
      },
    })

    hostMock.mockResolvedValue({ entries: [outlineEntry(0, 'u1', 'first')] })

    const hook = mountHook(() => useOutline('s1'))
    await flushMicrotasks()

    expect(hostMock).toHaveBeenCalledWith('sessions.outline', { sessionId: 's1' })
    expect(hook.current.rows).toEqual([{ entryId: 'u1', pos: 0, label: 'first', titled: false }])
    hook.unmount()
  })

  it('refreshes on opened(), persists generated titles into cache, and reuses them on remount', async () => {
    const { useOutline } = await import('./use-outline')
    commitCachedOutline('s1', [outlineEntry(0, 'u1', 'first line')])
    setMockReplica('s1', {
      older: null,
      state: { order: ['u1'], byId: { u1: userEntry('u1', 'first line') } },
    })

    hostMock.mockImplementation((method: string) => {
      if (method === 'sessions.outline') {
        return Promise.resolve({ entries: [outlineEntry(0, 'u1', 'first line')] })
      }
      if (method === 'sessions.outlineTitles') {
        return Promise.resolve({
          titles: [{ pos: 0, title: 'Summary title' }] satisfies OutlineTitle[],
        })
      }
      return Promise.resolve()
    })

    const hook = mountHook(() => useOutline('s1'))
    await flushMicrotasks()
    expect(hostMock).not.toHaveBeenCalled()

    hook.current.opened()
    await flushMicrotasks()

    expect(hostMock).toHaveBeenCalledWith('sessions.outline', { sessionId: 's1' })
    expect(hostMock).toHaveBeenCalledWith('sessions.outlineTitles', { sessionId: 's1' })
    expect(hook.current.rows).toEqual([
      { entryId: 'u1', pos: 0, label: 'Summary title', titled: true },
    ])

    // Unmount and remount: cached title persists immediately without re-fetching outline or titles.
    hook.unmount()
    hostMock.mockClear()
    const remounted = mountHook(() => useOutline('s1'))
    await flushMicrotasks()
    expect(hostMock).not.toHaveBeenCalled()
    expect(remounted.current.rows).toEqual([
      { entryId: 'u1', pos: 0, label: 'Summary title', titled: true },
    ])

    // Opening again refreshes outline, but skips outlineTitles since all rows are titled.
    remounted.current.opened()
    await flushMicrotasks()
    expect(hostMock).toHaveBeenCalledTimes(1)
    expect(hostMock).toHaveBeenCalledWith('sessions.outline', { sessionId: 's1' })
    remounted.unmount()
  })

  it('re-fetches automatically when invalidateOutlines clears the active session cache', async () => {
    const { useOutline } = await import('./use-outline')
    commitCachedOutline('s1', [outlineEntry(0, 'u1', 'cached')])
    setMockReplica('s1', {
      older: null,
      state: { order: ['u1'], byId: { u1: userEntry('u1', 'cached') } },
    })

    hostMock.mockResolvedValue({ entries: [outlineEntry(0, 'u1', 'reloaded')] })

    const hook = mountHook(() => useOutline('s1'))
    await flushMicrotasks()
    expect(hostMock).not.toHaveBeenCalled()

    invalidateOutlines((id) => id === 's1')
    await flushMicrotasks()

    expect(hostMock).toHaveBeenCalledTimes(1)
    expect(hostMock).toHaveBeenCalledWith('sessions.outline', { sessionId: 's1' })
    expect(hook.current.rows).toEqual([{ entryId: 'u1', pos: 0, label: 'reloaded', titled: false }])
    hook.unmount()
  })
})
