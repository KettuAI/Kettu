import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeObserverInstance {
  callback: IntersectionObserverCallback
  options?: IntersectionObserverInit
  observed: Set<Element>
  disconnected: boolean
}

describe('shared IntersectionObserver lifecycle cleanup', () => {
  const created: FakeObserverInstance[] = []

  beforeEach(() => {
    created.length = 0
    class FakeIntersectionObserver {
      readonly observed = new Set<Element>()
      disconnected = false
      constructor(
        readonly callback: IntersectionObserverCallback,
        readonly options?: IntersectionObserverInit,
      ) {
        created.push(this)
      }
      observe(target: Element) {
        this.observed.add(target)
      }
      unobserve(target: Element) {
        this.observed.delete(target)
      }
      disconnect() {
        this.disconnected = true
        this.observed.clear()
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('disconnects and forgets each scroller root observer in near-view once its last element unmounts', async () => {
    const { observeNearView, _nearViewObserversCountForTests } = await import('./near-view')
    const rootA = {} as Element
    const rootB = {} as Element
    const el1 = {} as Element
    const el2 = {} as Element
    const el3 = {} as Element

    const hits: string[] = []
    const stop1 = observeNearView(el1, rootA, () => hits.push('el1'))
    const stop2 = observeNearView(el2, rootA, () => hits.push('el2'))
    const stop3 = observeNearView(el3, rootB, () => hits.push('el3'))

    // Two distinct roots share two observers, not three.
    expect(created).toHaveLength(2)
    expect(_nearViewObserversCountForTests()).toBe(2)

    created[0]!.callback(
      [{ target: el1, isIntersecting: true } as IntersectionObserverEntry],
      created[0] as unknown as IntersectionObserver,
    )
    expect(hits).toEqual(['el1'])

    stop1()
    expect(created[0]!.disconnected).toBe(false)
    expect(_nearViewObserversCountForTests()).toBe(2)

    stop2()
    expect(created[0]!.disconnected).toBe(true)
    expect(_nearViewObserversCountForTests()).toBe(1)

    stop3()
    expect(created[1]!.disconnected).toBe(true)
    expect(_nearViewObserversCountForTests()).toBe(0)
  })

  it('disconnects the shared use-in-view observer when idle and recreates it cleanly on next mount', async () => {
    const { observeInView } = await import('@renderer/features/artifacts/use-in-view')
    const el1 = {} as Element
    const el2 = {} as Element

    let seen = false
    const stop1 = observeInView(el1, (v) => {
      seen = v
    })
    expect(created).toHaveLength(1)
    created[0]!.callback(
      [{ target: el1, isIntersecting: true } as IntersectionObserverEntry],
      created[0] as unknown as IntersectionObserver,
    )
    expect(seen).toBe(true)

    stop1()
    expect(created[0]!.disconnected).toBe(true)

    const stop2 = observeInView(el2, () => {})
    expect(created).toHaveLength(2)
    expect(created[1]!.disconnected).toBe(false)
    stop2()
    expect(created[1]!.disconnected).toBe(true)
  })
})
