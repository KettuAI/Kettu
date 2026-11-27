import { createElement, Fragment, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { BUILTIN_THEME_ID } from '@shared/themes'

const mockState = vi.hoisted(() => {
  const render = vi.fn<(id: string, code: string) => Promise<{ svg: string }>>()
  const getMermaid = vi.fn((...args: [unknown?]) => {
    void args
    return {
      initialize: vi.fn(),
      render,
    }
  })
  return {
    dark: false,
    render,
    getMermaid,
  }
})

vi.mock('@streamdown/mermaid', () => ({
  createMermaidPlugin: () => ({
    name: 'mermaid',
    type: 'diagram',
    language: 'mermaid',
    getMermaid: mockState.getMermaid,
  }),
}))

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@renderer/lib/platform', () => ({
  isMac: true,
  isWindows: false,
  isLinux: false,
  isMod: () => false,
  isWeb: false,
  platform: 'darwin',
  hasBand: false,
  formatShortcut: (shortcut: string) => shortcut,
}))

vi.mock('@renderer/hooks/use-dark', () => ({
  useDark: () => mockState.dark,
}))

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => createElement(Fragment, null, children),
  TooltipTrigger: ({ render, children }: { render?: ReactNode; children?: ReactNode }) =>
    createElement(Fragment, null, render ?? children),
  TooltipContent: () => null,
}))

vi.mock(
  '@hugeicons/core-free-icons',
  () =>
    new Proxy(
      {},
      {
        get: (_target, prop) => (prop === '__esModule' ? true : prop === 'then' ? undefined : prop),
        has: (_target, prop) => prop !== 'then',
      },
    ),
)

vi.mock('@hugeicons/react', () => ({
  HugeiconsIcon: () => null,
}))

vi.mock('streamdown', () => ({
  CodeBlock: ({ code }: { code: string }) => createElement('pre', null, code),
  useIsCodeFenceIncomplete: () => false,
}))

import { useSettingsStore } from '@renderer/stores/settings-store'
import { useThemesStore } from '@renderer/stores/themes'
import MermaidBlock from './mermaid-block'
import {
  _mermaidRenderForTests,
  createMermaidRenderer,
  estimatePictureBytes,
  MERMAID_RENDER_ID_PREFIX,
  mermaidCacheKey,
  MermaidPictureCache,
  mermaidThemeKey,
  requestMermaidPicture,
  type MermaidPicture,
  type MermaidRenderResult,
} from './mermaid-render'

const LIGHT_VARS: Record<string, string> = {
  background: '#ffffff',
  primaryTextColor: '#111111',
  lineColor: '#cccccc',
  fontFamily: 'Inter, sans-serif',
  fontSize: '12px',
}

const DARK_VARS: Record<string, string> = {
  background: '#111111',
  primaryTextColor: '#eeeeee',
  lineColor: '#444444',
  fontFamily: 'Inter, sans-serif',
  fontSize: '12px',
}

function fakePicture(tag: string, width = 320): MermaidPicture {
  const xml = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="120" data-tag="${tag}"></svg>`
  return {
    url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`,
    width,
    xml,
  }
}

function fakeToPicture(svg: string, background: string): MermaidRenderResult {
  if (svg === 'INVALID_NO_SVG') return { error: 'The output holds no SVG.' }
  if (svg === 'INVALID_NO_VIEWBOX') return { error: 'The SVG has no usable view box.' }
  return fakePicture(`${svg}|${background}`)
}

function immediateSchedule(run: () => void): () => void {
  let cancelled = false
  queueMicrotask(() => {
    if (!cancelled) run()
  })
  return () => {
    cancelled = true
  }
}

function createManualScheduler() {
  const pending: Array<{ run: () => void; cancelled: boolean }> = []
  return {
    schedule: (run: () => void) => {
      const task = { run, cancelled: false }
      pending.push(task)
      return () => {
        task.cancelled = true
      }
    },
    flushNext: () => {
      while (pending.length > 0) {
        const next = pending.shift()!
        if (!next.cancelled) {
          next.run()
          return true
        }
      }
      return false
    },
    pendingCount: () => pending.filter((t) => !t.cancelled).length,
  }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('MermaidPictureCache', () => {
  it('evicts the least recently used entry when exceeding maxEntries and refreshes order on get', () => {
    const cache = new MermaidPictureCache(() => ({ maxEntries: 2, maxBytes: 1024 * 1024 }))
    const a = fakePicture('a')
    const b = fakePicture('b')
    const c = fakePicture('c')

    cache.set('k-a', a)
    cache.set('k-b', b)
    // Touch k-a so k-b becomes the oldest entry.
    expect(cache.get('k-a')).toBe(a)

    cache.set('k-c', c)
    expect(cache.size).toBe(2)
    expect(cache.get('k-b')).toBeUndefined()
    expect(cache.get('k-a')).toBe(a)
    expect(cache.get('k-c')).toBe(c)
  })

  it('enforces maxBytes and refuses oversized single pictures without wiping existing entries', () => {
    const small1 = fakePicture('s1')
    const small2 = fakePicture('s2')
    const small3 = fakePicture('s3')
    const pairLimit = estimatePictureBytes(small1) + estimatePictureBytes(small2) + 16
    const cache = new MermaidPictureCache(() => ({ maxEntries: 10, maxBytes: pairLimit }))

    expect(cache.set('s1', small1)).toBe(true)
    expect(cache.set('s2', small2)).toBe(true)
    expect(cache.size).toBe(2)

    // Oversized single picture is rejected without evicting healthy cached entries.
    const huge = fakePicture('x'.repeat(2000))
    expect(cache.set('huge', huge)).toBe(false)
    expect(cache.size).toBe(2)
    expect(cache.get('s1')).toBe(small1)

    // Adding a third normal entry evicts s2 (oldest after s1 was touched above) to stay under maxBytes.
    expect(cache.set('s3', small3)).toBe(true)
    expect(cache.size).toBe(2)
    expect(cache.bytes).toBeLessThanOrEqual(pairLimit)
    expect(cache.get('s2')).toBeUndefined()
    expect(cache.get('s1')).toBe(small1)
    expect(cache.get('s3')).toBe(small3)
  })
})

describe('createMermaidRenderer', () => {
  it('serves cached hits synchronously and never calls mermaid.render twice on remount', async () => {
    const renderSvg = vi.fn(async (id: string, code: string) => ({ svg: `${id}:${code}` }))
    const renderer = createMermaidRenderer({
      renderSvg,
      toPicture: fakeToPicture,
      schedule: immediateSchedule,
    })

    const lightKey = mermaidThemeKey(LIGHT_VARS)
    expect(renderer.getCached('graph TD; A-->B', lightKey)).toBeUndefined()

    const first = await renderer.request({
      code: 'graph TD; A-->B',
      themeKey: lightKey,
      variables: LIGHT_VARS,
    }).promise
    expect('error' in first).toBe(false)
    expect(renderSvg).toHaveBeenCalledTimes(1)
    expect(renderSvg.mock.calls[0]![0]).toMatch(new RegExp(`^${MERMAID_RENDER_ID_PREFIX}\\d+$`))

    // Synchronous cache lookup and subsequent request both hit cache without re-rendering.
    const syncHit = renderer.getCached('graph TD; A-->B', lightKey)
    expect(syncHit).toBe(first)

    const second = await renderer.request({
      code: 'graph TD; A-->B',
      themeKey: lightKey,
      variables: LIGHT_VARS,
    }).promise
    expect(second).toBe(first)
    expect(renderSvg).toHaveBeenCalledTimes(1)
  })

  it('isolates cached diagrams across theme, dark mode, and font changes', async () => {
    const renderSvg = vi.fn(async (_id: string, code: string, vars: Record<string, string>) => ({
      svg: `${code}:${vars.background}:${vars.fontFamily}`,
    }))
    const renderer = createMermaidRenderer({
      renderSvg,
      toPicture: fakeToPicture,
      schedule: immediateSchedule,
    })

    const code = 'flowchart TD; A-->B'
    const lightKey = mermaidThemeKey(LIGHT_VARS)
    const darkKey = mermaidThemeKey(DARK_VARS)
    const customFontVars = { ...LIGHT_VARS, fontFamily: 'Manrope, sans-serif' }
    const customFontKey = mermaidThemeKey(customFontVars)

    expect(lightKey).not.toBe(darkKey)
    expect(lightKey).not.toBe(customFontKey)

    const lightPic = await renderer.request({ code, themeKey: lightKey, variables: LIGHT_VARS })
      .promise
    const darkPic = await renderer.request({ code, themeKey: darkKey, variables: DARK_VARS })
      .promise
    const fontPic = await renderer.request({
      code,
      themeKey: customFontKey,
      variables: customFontVars,
    }).promise

    expect(renderSvg).toHaveBeenCalledTimes(3)
    expect(lightPic).not.toEqual(darkPic)
    expect(lightPic).not.toEqual(fontPic)

    // Switching back to light or dark hits each theme's own cached entry with zero renders.
    expect(renderer.getCached(code, lightKey)).toBe(lightPic)
    expect(renderer.getCached(code, darkKey)).toBe(darkPic)
    expect(renderer.getCached(code, customFontKey)).toBe(fontPic)
    expect(renderSvg).toHaveBeenCalledTimes(3)
  })

  it('does not cache rejected renders or invalid SVG results, allowing later retries', async () => {
    let attempt = 0
    const renderSvg = vi.fn(async (_id: string, code: string) => {
      attempt += 1
      if (attempt === 1) throw new Error('Syntax error in diagram')
      if (attempt === 2) return { svg: 'INVALID_NO_VIEWBOX' }
      return { svg: `ok:${code}` }
    })
    const renderer = createMermaidRenderer({
      renderSvg,
      toPicture: fakeToPicture,
      schedule: immediateSchedule,
    })

    const code = 'graph TD; A-->B'
    const themeKey = mermaidThemeKey(LIGHT_VARS)

    const first = await renderer.request({ code, themeKey, variables: LIGHT_VARS }).promise
    expect(first).toEqual({ error: 'Syntax error in diagram' })
    expect(renderer.getCached(code, themeKey)).toBeUndefined()
    expect(renderer.cache.size).toBe(0)

    const second = await renderer.request({ code, themeKey, variables: LIGHT_VARS }).promise
    expect(second).toEqual({ error: 'The SVG has no usable view box.' })
    expect(renderer.getCached(code, themeKey)).toBeUndefined()
    expect(renderer.cache.size).toBe(0)

    const third = await renderer.request({ code, themeKey, variables: LIGHT_VARS }).promise
    expect('error' in third).toBe(false)
    expect(renderer.getCached(code, themeKey)).toBe(third)
    expect(renderSvg).toHaveBeenCalledTimes(3)
  })

  it('deduplicates concurrent in-flight requests for the same diagram and theme', async () => {
    const deferred = createDeferred<{ svg: string }>()
    const renderSvg = vi.fn(() => deferred.promise)
    const scheduler = createManualScheduler()
    const renderer = createMermaidRenderer({
      renderSvg,
      toPicture: fakeToPicture,
      schedule: scheduler.schedule,
    })

    const code = 'flowchart TD; Node1-->Node2'
    const themeKey = mermaidThemeKey(LIGHT_VARS)

    const req1 = renderer.request({ code, themeKey, variables: LIGHT_VARS })
    const req2 = renderer.request({ code, themeKey, variables: LIGHT_VARS })
    const req3 = renderer.request({ code, themeKey, variables: LIGHT_VARS })

    expect(renderer.inFlightCount()).toBe(1)
    expect(renderer.queueLength()).toBe(1)

    // Cancelling one subscriber leaves the shared job intact for the remaining callers.
    req2.cancel()
    req2.cancel() // idempotent cancel must not double-decrement
    expect(renderer.inFlightCount()).toBe(1)

    expect(scheduler.flushNext()).toBe(true)
    expect(renderSvg).toHaveBeenCalledTimes(1)

    deferred.resolve({ svg: 'dedup-ok' })
    const [res1, res3] = await Promise.all([req1.promise, req3.promise])
    expect(res1).toBe(res3)
    expect('error' in res1).toBe(false)
    expect(renderer.inFlightCount()).toBe(0)
    expect(renderer.getCached(code, themeKey)).toBe(res1)
  })

  it('skips queued work when all subscribers cancel before execution starts, but caches started jobs', async () => {
    const renderSvg = vi.fn(async (_id: string, code: string) => ({ svg: `svg:${code}` }))
    const scheduler = createManualScheduler()
    const renderer = createMermaidRenderer({
      renderSvg,
      toPicture: fakeToPicture,
      schedule: scheduler.schedule,
    })

    const themeKey = mermaidThemeKey(LIGHT_VARS)

    // Cancel before the scheduled callback fires -> never calls mermaid.render.
    const handleA = renderer.request({ code: 'graph TD; X-->Y', themeKey, variables: LIGHT_VARS })
    handleA.cancel()
    expect(renderer.inFlightCount()).toBe(0)
    expect(renderer.queueLength()).toBe(0)
    expect(scheduler.pendingCount()).toBe(0)
    expect(renderSvg).not.toHaveBeenCalled()

    // Cancel after execution starts -> result is still cached for fast remount.
    const deferred = createDeferred<{ svg: string }>()
    renderSvg.mockImplementationOnce(() => deferred.promise)
    const handleB = renderer.request({ code: 'graph TD; M-->N', themeKey, variables: LIGHT_VARS })
    expect(scheduler.flushNext()).toBe(true)
    expect(renderSvg).toHaveBeenCalledTimes(1)
    handleB.cancel()
    deferred.resolve({ svg: 'finished-after-unmount' })
    await handleB.promise
    expect(renderer.getCached('graph TD; M-->N', themeKey)).toBeDefined()
  })

  it('runs distinct diagrams serially across frames and cleans up temporary nodes', async () => {
    const order: string[] = []
    const cleaned: string[] = []
    const d1 = createDeferred<{ svg: string }>()
    const d2 = createDeferred<{ svg: string }>()
    const scheduler = createManualScheduler()
    const renderSvg = vi.fn((id: string, code: string) => {
      order.push(`start:${code}:${id}`)
      return code === 'diag-1' ? d1.promise : d2.promise
    })
    const renderer = createMermaidRenderer({
      renderSvg,
      toPicture: fakeToPicture,
      schedule: scheduler.schedule,
      cleanupTempNodes: (id) => cleaned.push(id),
    })

    const themeKey = mermaidThemeKey(LIGHT_VARS)
    const r1 = renderer.request({ code: 'diag-1', themeKey, variables: LIGHT_VARS })
    const r2 = renderer.request({ code: 'diag-2', themeKey, variables: LIGHT_VARS })

    expect(scheduler.flushNext()).toBe(true)
    expect(order).toEqual([`start:diag-1:${MERMAID_RENDER_ID_PREFIX}1`])
    // Second diagram waits in queue until the first settles and yields to the scheduler.
    expect(scheduler.pendingCount()).toBe(0)

    d1.resolve({ svg: 'svg-1' })
    await r1.promise
    expect(cleaned).toEqual([`${MERMAID_RENDER_ID_PREFIX}1`])
    expect(scheduler.pendingCount()).toBe(1)

    expect(scheduler.flushNext()).toBe(true)
    expect(order).toEqual([
      `start:diag-1:${MERMAID_RENDER_ID_PREFIX}1`,
      `start:diag-2:${MERMAID_RENDER_ID_PREFIX}2`,
    ])
    d2.resolve({ svg: 'svg-2' })
    await r2.promise
    expect(cleaned).toEqual([`${MERMAID_RENDER_ID_PREFIX}1`, `${MERMAID_RENDER_ID_PREFIX}2`])
  })
})

describe('default renderer plugin config reuse & MermaidBlock synchronous cache hit', () => {
  beforeEach(() => {
    _mermaidRenderForTests.clear()
    mockState.dark = false
    mockState.render.mockReset()
    mockState.getMermaid.mockClear()
    useThemesStore.setState({
      state: { installed: [], chosen: BUILTIN_THEME_ID, failed: null },
      shown: null,
    })
    useSettingsStore.setState({
      settings: structuredClone(DEFAULT_SETTINGS),
      loaded: true,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    _mermaidRenderForTests.clear()
  })

  it('skips redundant plugin initialize calls when rendering multiple diagrams under the same theme', async () => {
    mockState.render.mockResolvedValue({
      svg: '<svg viewBox="0 0 100 50"></svg>',
    })
    vi.stubGlobal(
      'DOMParser',
      class {
        parseFromString() {
          const attrs = new Map<string, string>([['viewBox', '0 0 100 50']])
          const svg = {
            getAttribute: (name: string) => attrs.get(name) ?? null,
            setAttribute: (name: string, value: string) => attrs.set(name, value),
            removeAttribute: (name: string) => attrs.delete(name),
            prepend: () => {},
            ownerDocument: {
              createElementNS: () => ({ setAttribute: () => {} }),
            },
          }
          return { body: { querySelector: () => svg } }
        }
      },
    )
    vi.stubGlobal(
      'XMLSerializer',
      class {
        serializeToString() {
          return '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"></svg>'
        }
      },
    )

    const lightKey = mermaidThemeKey(LIGHT_VARS)
    const darkKey = mermaidThemeKey(DARK_VARS)

    await requestMermaidPicture({
      code: 'graph TD; A-->B',
      themeKey: lightKey,
      variables: LIGHT_VARS,
    }).promise
    await requestMermaidPicture({
      code: 'graph TD; C-->D',
      themeKey: lightKey,
      variables: LIGHT_VARS,
    }).promise
    await requestMermaidPicture({
      code: 'graph TD; E-->F',
      themeKey: darkKey,
      variables: DARK_VARS,
    }).promise

    // 1st call initializes light, 2nd reuses without config arg, 3rd re-initializes for dark.
    expect(mockState.getMermaid).toHaveBeenCalledTimes(3)
    expect(mockState.getMermaid.mock.calls[0]![0]).toBeDefined()
    expect(mockState.getMermaid.mock.calls[1]![0]).toBeUndefined()
    expect(mockState.getMermaid.mock.calls[2]![0]).toBeDefined()
  })

  it('renders the cached picture synchronously on first mount and isolates light/dark themes', () => {
    const tokensByMode: Record<'light' | 'dark', Record<string, string>> = {
      light: {
        '--bg-surface': '#ffffff',
        '--bg-subtle': '#f5f5f5',
        '--text-primary': '#111111',
        '--border-default': '#dddddd',
        '--border-strong': '#aaaaaa',
      },
      dark: {
        '--bg-surface': '#121212',
        '--bg-subtle': '#1f1f1f',
        '--text-primary': '#f2f2f2',
        '--border-default': '#333333',
        '--border-strong': '#555555',
      },
    }

    const doc = {
      documentElement: {},
      body: {},
    }
    vi.stubGlobal('document', doc)
    vi.stubGlobal('getComputedStyle', (el: unknown) => {
      if (el === doc.body) return { fontFamily: 'Inter, sans-serif' }
      const palette = mockState.dark ? tokensByMode.dark : tokensByMode.light
      return { getPropertyValue: (name: string) => palette[name] ?? '' }
    })

    const code = 'flowchart TD\n  A[Start] --> B[End]'
    const buildVars = (mode: 'light' | 'dark') => {
      const p = tokensByMode[mode]
      return {
        background: p['--bg-surface']!,
        mainBkg: p['--bg-surface']!,
        primaryColor: p['--bg-surface']!,
        secondaryColor: p['--bg-subtle']!,
        tertiaryColor: p['--bg-subtle']!,
        primaryBorderColor: p['--border-default']!,
        secondaryBorderColor: p['--border-default']!,
        tertiaryBorderColor: p['--border-default']!,
        nodeBorder: p['--border-default']!,
        clusterBkg: p['--bg-subtle']!,
        clusterBorder: p['--border-default']!,
        primaryTextColor: p['--text-primary']!,
        secondaryTextColor: p['--text-primary']!,
        tertiaryTextColor: p['--text-primary']!,
        textColor: p['--text-primary']!,
        titleColor: p['--text-primary']!,
        edgeLabelBackground: p['--bg-surface']!,
        lineColor: p['--border-strong']!,
        fontFamily: 'Inter, sans-serif',
        fontSize: '12px',
      }
    }

    const lightThemeKey = mermaidThemeKey(buildVars('light'))
    const darkThemeKey = mermaidThemeKey(buildVars('dark'))
    const lightPicture = fakePicture('light-diagram', 420)
    const darkPicture = fakePicture('dark-diagram', 420)

    _mermaidRenderForTests.seed(code, lightThemeKey, lightPicture)

    // Light mode cache hit renders the <img> immediately without falling back to CodeFrame.
    mockState.dark = false
    const lightHtml = renderToStaticMarkup(
      createElement(MermaidBlock, { code, language: 'mermaid', isIncomplete: false }),
    )
    expect(lightHtml).toContain('class="block-picture"')
    expect(lightHtml).toContain(`src="${lightPicture.url}"`)
    expect(lightHtml).toContain('width="420"')

    // Streaming block always stays as CodeFrame even when cached.
    const streamingHtml = renderToStaticMarkup(
      createElement(MermaidBlock, { code, language: 'mermaid', isIncomplete: true }),
    )
    expect(streamingHtml).not.toContain('class="block-picture"')
    expect(streamingHtml).toContain('<pre>')

    // Switching to dark mode before dark cache exists must NOT show the light SVG.
    mockState.dark = true
    const uncachedDarkHtml = renderToStaticMarkup(
      createElement(MermaidBlock, { code, language: 'mermaid', isIncomplete: false }),
    )
    expect(uncachedDarkHtml).not.toContain(lightPicture.url)
    expect(uncachedDarkHtml).toContain('<pre>')

    // Once dark cache is populated, dark mode renders its own dark SVG synchronously.
    _mermaidRenderForTests.seed(code, darkThemeKey, darkPicture)
    const cachedDarkHtml = renderToStaticMarkup(
      createElement(MermaidBlock, { code, language: 'mermaid', isIncomplete: false }),
    )
    expect(cachedDarkHtml).toContain(`src="${darkPicture.url}"`)
    expect(cachedDarkHtml).not.toContain(lightPicture.url)
    expect(mermaidCacheKey(code, lightThemeKey)).not.toBe(mermaidCacheKey(code, darkThemeKey))
  })
})
