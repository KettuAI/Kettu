import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThemeRegistration } from 'shiki'
import { createCodePlugin, _codePluginCacheForTests } from './code-plugin'

const LIGHT_THEME: ThemeRegistration = {
  name: 'test-light',
  type: 'light',
  fg: '#111111',
  bg: '#ffffff',
  settings: [{ scope: 'keyword', settings: { foreground: '#0000cc' } }],
}

const DARK_THEME: ThemeRegistration = {
  name: 'test-dark',
  type: 'dark',
  fg: '#eeeeee',
  bg: '#111111',
  settings: [{ scope: 'keyword', settings: { foreground: '#66aaff' } }],
}

async function highlightAsync(
  plugin: ReturnType<typeof createCodePlugin>,
  code: string,
  language: 'typescript' | 'json' | 'bash',
  isIncomplete = false,
) {
  const themes = plugin.getThemes()
  return await new Promise<NonNullable<ReturnType<typeof plugin.highlight>>>((resolve) => {
    const sync = plugin.highlight({ code, language, themes, isIncomplete }, (asyncResult) =>
      resolve(asyncResult),
    )
    if (sync) resolve(sync)
  })
}

describe('shared Shiki code plugin', () => {
  beforeEach(() => {
    _codePluginCacheForTests.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    _codePluginCacheForTests.clear()
  })

  it('highlights multiple languages through a shared highlighter and serves cached hits synchronously', async () => {
    const plugin = createCodePlugin({ themes: [LIGHT_THEME, DARK_THEME] })
    const ts = await highlightAsync(plugin, 'export const answer = 42', 'typescript')
    expect(ts.tokens.length).toBe(1)
    expect(ts.tokens[0]!.length).toBeGreaterThan(1)

    const json = await highlightAsync(plugin, '{"ok": true}', 'json')
    expect(json.tokens.length).toBe(1)

    // Subsequent call for the same block returns synchronously from cache.
    const cached = plugin.highlight({
      code: 'export const answer = 42',
      language: 'typescript',
      themes: plugin.getThemes(),
    })
    expect(cached).toBe(ts)
  })

  it('degrades huge blocks to plain tokens synchronously without populating the cache', () => {
    const plugin = createCodePlugin({ themes: [LIGHT_THEME, DARK_THEME] })
    const huge = 'const x = 1;\n'.repeat(5_500)
    const result = plugin.highlight({
      code: huge,
      language: 'typescript',
      themes: plugin.getThemes(),
    })
    expect(result).not.toBeNull()
    expect(result!.tokens.length).toBe(5_501)
    expect(_codePluginCacheForTests.size()).toBe(0)
  })

  it('bounds the web token cache and streaming prefix cache via LRU eviction', async () => {
    vi.stubGlobal('window', { kettu: { client: 'web' } })
    const plugin = createCodePlugin({ themes: [LIGHT_THEME, DARK_THEME] })
    // Prime highlighter and language once.
    await highlightAsync(plugin, 'const init = 0', 'typescript')

    for (let i = 0; i < 160; i++) {
      await highlightAsync(plugin, `const item_${i} = ${i}`, 'typescript', false)
    }
    expect(_codePluginCacheForTests.size()).toBeLessThanOrEqual(120)
    expect(_codePluginCacheForTests.streamPrefixCount()).toBe(0)

    for (let i = 0; i < 20; i++) {
      await highlightAsync(plugin, `const stream_${i} = ${i}\nconst next = 1`, 'typescript', true)
    }
    expect(_codePluginCacheForTests.streamPrefixCount()).toBeLessThanOrEqual(8)
  })
})
