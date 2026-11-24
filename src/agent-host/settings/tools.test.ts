import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { SettingFacts, SettingsSnapshot } from '@shared/host-control'
import type { CatalogPlugin } from '@shared/settings-catalog'
import { DEFAULT_SETTINGS, type SettingsFile, type SettingsPatch } from '@shared/settings'
import type { SettingScalar } from '@shared/settings-catalog'
import type { SettingChangeItem, SettingsChangeOutcome } from '@shared/thread'
import { setLocale, tSettings, tSettingsEnglish } from '../i18n'
import { mergeSettings, validateSettingsPatch } from '../../main/settings-schema'
import {
  CHANGE_SETTINGS,
  FIND_SETTINGS,
  OPEN_SETTINGS,
  SettingsTools,
  StaleUndo,
  type LocalFacts,
  type SettingsAnswer,
  type SettingsAsk,
} from './tools'

const CALLER = { sessionId: 's1', project: '/p' }
const SECRET = 'sk-live-0123456789abcdef'

function text(result: CallToolResult): string {
  return result.content.map((part) => ('text' in part ? part.text : '')).join('\n')
}

function harness(
  options: {
    fullAccess?: boolean
    file?: Partial<SettingsFile>
    facts?: SettingFacts
    plugins?: CatalogPlugin[]
    /** What the host reads of the plugins' settings, by tool id. */
    pluginFacts?: SettingFacts
  } = {},
) {
  let file: SettingsFile = { ...structuredClone(DEFAULT_SETTINGS), ...options.file }
  const applied: SettingsPatch[] = []
  const asked: SettingsAsk[] = []
  const recorded: SettingChangeItem[][] = []
  const settled: SettingsChangeOutcome[] = []
  let answer: (given: SettingsAnswer) => void = () => {}
  const snapshot = (): SettingsSnapshot => ({
    file,
    desktop: true,
    facts: { 'sharing.cloudflare': SECRET, ...options.facts },
  })
  const local: LocalFacts = {
    agents: [{ id: 'codex', name: 'Codex', harnessId: 'codex' }],
    harnesses: [{ id: 'codex', name: 'Codex' }],
    modes: { codex: [{ value: 'agent', name: 'Auto' }] },
    plugins: options.plugins ?? [],
    // The host itself only ever sends whether a key is set; a string here must not leak either.
    facts: { 'agents.api-key:codex': SECRET, ...options.pluginFacts },
  }
  const pluginSets: [string, string, SettingScalar][] = []
  const tools = new SettingsTools({
    platform: 'darwin',
    read: async () => snapshot(),
    apply: async (patch) => {
      // The same checks as the Settings page.
      file = mergeSettings(file, validateSettingsPatch(patch))
      applied.push(patch)
      return snapshot()
    },
    setPluginSetting: async (pluginId, key, value) => {
      pluginSets.push([pluginId, key, value])
      // The host reads the value back from its own record, which the next call sees.
      const id = typeof value === 'boolean' ? 'plugins.switch' : 'plugins.text'
      local.facts[`${id}:${pluginId}:${key}`] = value
    },
    local: async () => local,
    fullAccess: () => options.fullAccess === true,
    ask: (_, ask) => {
      asked.push(ask)
      return { entryId: 'e1', answer: new Promise((resolve) => (answer = resolve)) }
    },
    recorded: (_, items) => {
      recorded.push(items)
      return 'e2'
    },
    settle: (_, __, outcome) => settled.push(outcome),
    open: () => false,
    words: tSettings,
    english: tSettingsEnglish,
  })
  return {
    tools,
    applied,
    asked,
    recorded,
    settled,
    pluginSets,
    file: () => file,
    answer: (given: SettingsAnswer) => answer(given),
  }
}

const change = (tools: SettingsTools, changes: { id: string; value: unknown }[]) =>
  tools.call(CALLER, CHANGE_SETTINGS, { changes })

afterEach(() => {
  setLocale('en')
  vi.useRealTimers()
})

describe('find_settings', () => {
  it('finds rows by English and Chinese words, with their values', async () => {
    const { tools } = harness()
    const found = await tools.call(CALLER, FIND_SETTINGS, { query: 'dark' })
    expect(text(found)).toContain('appearance.color-mode')
    expect(text(found)).toContain('value: System')
    setLocale('zh-CN')
    const zh = await tools.call(CALLER, FIND_SETTINGS, { query: '深色' })
    expect(text(zh)).toContain('appearance.color-mode')
    expect(text(zh)).toContain('颜色模式 (Color mode)')
  })

  it('fills the placeholders of a row’s words', async () => {
    const { tools } = harness()
    const found = text(await tools.call(CALLER, FIND_SETTINGS, { query: 'zoom' }))
    expect(found).toContain('⌘= and ⌘- work anywhere')
    expect(found).not.toContain('{{')
  })

  it('lists the rows of each agent by its id', async () => {
    const { tools } = harness()
    const all = text(await tools.call(CALLER, FIND_SETTINGS, {}))
    expect(all).toContain('agents.start-mode:codex')
    expect(all).toContain('harnesses.auto-update:codex')
  })

  it('never gives a secret’s value, only whether it is set', async () => {
    const { tools } = harness()
    const all = await tools.call(CALLER, FIND_SETTINGS, {})
    const sharing = await tools.call(CALLER, FIND_SETTINGS, { query: 'cloudflare' })
    const key = await tools.call(CALLER, FIND_SETTINGS, { query: 'key codex' })
    for (const result of [all, sharing, key]) {
      expect(JSON.stringify(result)).not.toContain(SECRET)
    }
    expect(text(sharing)).toContain('value: Set')
  })

  it('hides a proxy’s password and refuses to change a proxy that has one', async () => {
    const proxy = {
      mode: 'custom' as const,
      url: 'http://me:hunter2@proxy.example:8080',
      noProxy: '',
    }
    const { tools, applied } = harness({ fullAccess: true, file: { proxy } })
    const found = await tools.call(CALLER, FIND_SETTINGS, { query: 'proxy' })
    expect(JSON.stringify(found)).not.toContain('hunter2')
    const result = await change(tools, [{ id: 'advanced.proxy', value: 'http://other:3128' }])
    expect(result.isError).toBe(true)
    expect(applied).toEqual([])
  })
})

describe('change_settings', () => {
  it('asks in a card outside Full access, and changes only on Change', async () => {
    const { tools, applied, asked, settled, answer, file } = harness()
    vi.useFakeTimers()
    const pending = change(tools, [{ id: 'appearance.color-mode', value: 'dark' }])
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    expect(applied).toEqual([])
    expect(asked[0]!.items[0]).toMatchObject({
      id: 'appearance.color-mode',
      from: { value: 'system', text: 'System' },
      to: { value: 'dark', text: 'Dark' },
    })
    answer({ decision: 'change' })
    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(file().appearance.theme).toBe('dark')
    expect(settled).toEqual([{ kind: 'changed' }])
  })

  it("changes nothing on Don't change", async () => {
    const { tools, applied, asked, answer } = harness()
    const pending = change(tools, [{ id: 'general.restore', value: false }])
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    answer({ decision: 'keep' })
    expect(text(await pending)).toContain("Don't change")
    expect(applied).toEqual([])
  })

  it('returns within a minute, and the same call again waits on the same card', async () => {
    vi.useFakeTimers()
    const { tools, asked, answer } = harness()
    const first = change(tools, [{ id: 'general.restore', value: false }])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(text(await first)).toContain('has not answered')
    const second = change(tools, [{ id: 'general.restore', value: false }])
    await vi.advanceTimersByTimeAsync(0)
    answer({ decision: 'change' })
    expect(text(await second)).toContain('Changed')
    expect(asked).toHaveLength(1)
  })

  it('changes at once in Full access and leaves a line', async () => {
    const { tools, asked, recorded, file } = harness({ fullAccess: true })
    const result = await change(tools, [
      { id: 'appearance.color-mode', value: 'dark' },
      { id: 'appearance.zoom', value: 1.25 },
    ])
    expect(result.isError).toBeUndefined()
    expect(asked).toEqual([])
    expect(recorded[0]!.map((item) => item.id)).toEqual([
      'appearance.color-mode',
      'appearance.zoom',
    ])
    expect(file().appearance).toMatchObject({ theme: 'dark', zoom: 1.25 })
  })

  it('still asks in Full access for a row that widens access, with its warning', async () => {
    const { tools, asked, recorded } = harness({ fullAccess: true })
    void change(tools, [{ id: 'remote.terminal', value: true }])
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    expect(recorded).toEqual([])
    expect(asked[0]!.items[0]!.warning).toContain('run any command')
  })

  it('still asks in Full access before agents may type passwords', async () => {
    const { tools, asked, applied, recorded } = harness({ fullAccess: true })
    void change(tools, [{ id: 'general.agent-passwords', value: true }])
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    expect(applied).toEqual([])
    expect(recorded).toEqual([])
    expect(asked[0]!.items[0]!.warning).toContain('type passwords and codes')
  })

  it('never changes secrets, paths or actions', async () => {
    const { tools, applied, asked } = harness({ fullAccess: true })
    for (const id of [
      'sharing.cloudflare',
      'agents.api-key:codex',
      'terminal.shell',
      'harnesses.program:codex',
      'git.worktree-root',
      'advanced.remove-sessions',
      'harnesses.install:codex',
      'agents.remove:codex',
      'account.account',
    ]) {
      const result = await change(tools, [{ id, value: '/tmp/x' }])
      expect(result.isError, id).toBe(true)
      expect(JSON.stringify(result)).not.toContain(SECRET)
    }
    expect(applied).toEqual([])
    expect(asked).toEqual([])
  })

  it('refuses a value the row does not take, listing those it does, and changes none', async () => {
    const { tools, applied } = harness({ fullAccess: true })
    const result = await change(tools, [
      { id: 'general.restore', value: false },
      { id: 'appearance.color-mode', value: 'purple' },
    ])
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('"system", "light", "dark"')
    expect(applied).toEqual([])
  })

  it('refuses a row the host does not have, such as a window’s on another host', async () => {
    const { tools, applied } = harness({ fullAccess: true })
    expect((await change(tools, [{ id: 'agents.enabled:nobody', value: true }])).isError).toBe(true)
    expect((await change(tools, [{ id: 'appearance.nothing', value: true }])).isError).toBe(true)
    expect(applied).toEqual([])
  })
})

describe('open_settings', () => {
  it('says where the row is when no window shows the session', async () => {
    const { tools } = harness()
    const result = await tools.call(CALLER, OPEN_SETTINGS, { id: 'appearance.color-mode' })
    expect(text(result)).toContain('Settings › Appearance › Theme › Color mode')
  })
})

describe('undo', () => {
  it('sets the rows back, unless one changed again since', async () => {
    const { tools, recorded, file } = harness({ fullAccess: true })
    await change(tools, [{ id: 'appearance.color-mode', value: 'dark' }])
    await tools.undo(recorded[0]!)
    expect(file().appearance.theme).toBe('system')
    await change(tools, [{ id: 'appearance.color-mode', value: 'light' }])
    await change(tools, [{ id: 'appearance.color-mode', value: 'dark' }])
    await expect(tools.undo(recorded[1]!)).rejects.toBeInstanceOf(StaleUndo)
  })
})

describe("a plugin's settings", () => {
  const PLUGIN = 'p0123456789ab'
  const plugins: CatalogPlugin[] = [
    {
      id: PLUGIN,
      title: 'Acme',
      settings: [
        { key: 'verbose', type: 'boolean', title: 'Verbose logging', description: 'Logs more.' },
        {
          key: 'mode',
          type: 'select',
          title: 'Mode',
          options: [
            { value: 'fast', title: 'Fast' },
            { value: 'deep', title: 'Deep' },
          ],
        },
        { key: 'name', type: 'string', title: 'Display name' },
        { key: 'token', type: 'secret', title: 'Access token' },
      ],
    },
  ]
  const pluginFacts: SettingFacts = {
    [`plugins.switch:${PLUGIN}:verbose`]: false,
    [`plugins.choice:${PLUGIN}:mode`]: 'fast',
    [`plugins.text:${PLUGIN}:name`]: 'Ada',
    [`plugins.secret:${PLUGIN}:token`]: true,
  }

  it('are found with the plugin’s own words, the place and the values they take', async () => {
    const { tools } = harness({ plugins, pluginFacts })
    const found = text(await tools.call(CALLER, FIND_SETTINGS, { query: 'verbose' }))
    expect(found).toContain(`plugins.switch:${PLUGIN}:verbose`)
    expect(found).toContain('Plugins › Acme › Verbose logging')
    expect(found).toContain('Logs more.')
    expect(found).toContain('value: Off')
    const mode = text(await tools.call(CALLER, FIND_SETTINGS, { query: 'acme mode' }))
    expect(mode).toContain('takes "fast" (Fast), "deep" (Deep)')
  })

  it('give a secret only as set or not set, and never to be changed', async () => {
    const { tools, pluginSets } = harness({ fullAccess: true, plugins, pluginFacts })
    const found = text(await tools.call(CALLER, FIND_SETTINGS, { query: 'access token' }))
    expect(found).toContain('value: Set')
    expect(found).toContain('a secret')
    const result = await change(tools, [{ id: `plugins.secret:${PLUGIN}:token`, value: 'x' }])
    expect(result.isError).toBe(true)
    expect(pluginSets).toEqual([])
  })

  it('are listed only for a plugin the host has, and none without', async () => {
    const { tools } = harness()
    const all = text(await tools.call(CALLER, FIND_SETTINGS, {}))
    expect(all).not.toContain('plugins.switch')
    const result = await change(tools, [{ id: `plugins.switch:${PLUGIN}:verbose`, value: true }])
    expect(result.isError).toBe(true)
  })

  it('change in a card outside Full access, and through the plugin’s own record', async () => {
    const { tools, pluginSets, applied, asked, answer } = harness({ plugins, pluginFacts })
    const pending = change(tools, [{ id: `plugins.switch:${PLUGIN}:verbose`, value: true }])
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    expect(asked[0]!.items[0]).toMatchObject({
      id: `plugins.switch:${PLUGIN}:verbose`,
      place: 'Plugins › Acme',
      name: 'Verbose logging',
      from: { value: false, text: 'Off' },
      to: { value: true, text: 'On' },
      section: 'plugins',
      item: PLUGIN,
      row: 'setting-verbose',
    })
    expect(pluginSets).toEqual([])
    answer({ decision: 'change' })
    expect((await pending).isError).toBeUndefined()
    // Not a patch of the settings file: the plugin's record holds it.
    expect(applied).toEqual([])
    expect(pluginSets).toEqual([[PLUGIN, 'verbose', true]])
  })

  it('change at once in Full access, with a line, and refuse a choice the plugin does not offer', async () => {
    const { tools, pluginSets, recorded } = harness({ fullAccess: true, plugins, pluginFacts })
    const bad = await change(tools, [{ id: `plugins.choice:${PLUGIN}:mode`, value: 'slow' }])
    expect(bad.isError).toBe(true)
    expect(text(bad)).toContain('"fast", "deep"')
    const ok = await change(tools, [
      { id: `plugins.choice:${PLUGIN}:mode`, value: 'deep' },
      { id: `plugins.text:${PLUGIN}:name`, value: 'Bea' },
    ])
    expect(ok.isError).toBeUndefined()
    expect(pluginSets).toEqual([
      [PLUGIN, 'mode', 'deep'],
      [PLUGIN, 'name', 'Bea'],
    ])
    expect(recorded[0]!.map((item) => item.name)).toEqual(['Mode', 'Display name'])
  })

  it('are put back by Undo, unless one changed again since', async () => {
    const { tools, pluginSets, recorded } = harness({ fullAccess: true, plugins, pluginFacts })
    await change(tools, [{ id: `plugins.switch:${PLUGIN}:verbose`, value: true }])
    await tools.undo(recorded[0]!)
    expect(pluginSets.at(-1)).toEqual([PLUGIN, 'verbose', false])
    // It holds false again, so a second undo of the same line finds it changed since.
    await expect(tools.undo(recorded[0]!)).rejects.toBeInstanceOf(StaleUndo)
  })

  it('open at the plugin’s page and the row on it', async () => {
    const { tools } = harness({ plugins, pluginFacts })
    const result = await tools.call(CALLER, OPEN_SETTINGS, { id: `plugins.secret:${PLUGIN}:token` })
    expect(text(result)).toContain('Plugins › Acme › Access token')
  })
})
