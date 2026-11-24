import { describe, expect, it } from 'vitest'
import { HOST_METHODS, REMOVED_PLUGIN_METHODS } from '@shared/agent-host'
import { createValidators, promptContent } from './validate'

const posix = createValidators('darwin')
const windows = createValidators('win32')

function rejects(run: () => unknown): void {
  expect(run).toThrow(expect.objectContaining({ code: 'invalid_params' }))
}

describe('createValidators', () => {
  it('has a validator for every method', () => {
    expect(Object.keys(posix).sort()).toEqual([...HOST_METHODS].sort())
  })

  it('accepts methods without params with nothing, null or an empty object', () => {
    expect(posix['agents.list'](undefined)).toBeUndefined()
    expect(posix['agents.list'](null)).toBeUndefined()
    expect(posix['agents.list']({})).toBeUndefined()
    rejects(() => posix['agents.list']({ extra: 1 }))
  })

  it('takes no repository or anything else for a star, which is always Kettu’s own', () => {
    for (const method of ['star.state', 'star.add', 'star.dismiss', 'star.opened'] as const) {
      expect(posix[method](undefined)).toBeUndefined()
      rejects(() => posix[method]({ repository: 'someone/else' }))
      rejects(() => posix[method]({ args: ['repo', 'delete'] }))
    }
  })

  it('returns only the known fields', () => {
    expect(posix['sessions.open']({ sessionId: 's', other: 'x' })).toEqual({ sessionId: 's' })
    expect(posix['agents.check']({})).toEqual({})
    expect(posix['agents.check']({ agentId: 'codex' })).toEqual({ agentId: 'codex' })
  })

  it('checks types, required fields and lengths', () => {
    rejects(() => posix['sessions.open']({}))
    rejects(() => posix['sessions.open']({ sessionId: 1 }))
    rejects(() => posix['sessions.open']({ sessionId: '' }))
    rejects(() => posix['sessions.open']({ sessionId: 'x'.repeat(257) }))
    rejects(() => posix['sessions.open']('s'))
    rejects(() => posix['sessions.open']([]))
    rejects(() => posix['agents.logout']({ agentId: 'unknown-agent' }))
  })

  it('takes nothing for the idle sessions’ rule, which the host decides alone', () => {
    expect(posix['sessions.idleRelease'](undefined)).toBeUndefined()
    expect(posix['sessions.idleRelease']({})).toBeUndefined()
    rejects(() => posix['sessions.idleRelease']({ memory: 'plenty' }))
    rejects(() => posix['sessions.idleRelease']({ fallback: ['2.1.325'] }))
  })

  it('takes a bounded list of session ids for the running work ending them would stop', () => {
    expect(posix['sessions.runningWork']({ sessionIds: ['a', 'b'], other: 1 })).toEqual({
      sessionIds: ['a', 'b'],
    })
    expect(posix['sessions.runningWork']({ sessionIds: [] })).toEqual({ sessionIds: [] })
    rejects(() => posix['sessions.runningWork']({}))
    rejects(() => posix['sessions.runningWork']({ sessionIds: 'a' }))
    rejects(() => posix['sessions.runningWork']({ sessionIds: [1] }))
    rejects(() => posix['sessions.runningWork']({ sessionIds: [''] }))
    rejects(() => posix['sessions.runningWork']({ sessionIds: ['x'.repeat(257)] }))
    rejects(() =>
      posix['sessions.runningWork']({ sessionIds: Array.from({ length: 10_001 }, () => 's') }),
    )
  })

  it('takes a fork for an import only when asked', () => {
    const base = { agentId: 'claude-code', projectPath: '/p', acpSessionId: 'id' }
    expect(posix['sessions.import']({ ...base, fork: true })).toEqual({ ...base, fork: true })
    expect(posix['sessions.import']({ ...base, fork: 'yes' })).toEqual(base)
  })

  it('archives a whole tree unless asked, as a boolean, to leave the sub-sessions', () => {
    const archive = posix['sessions.archive']
    expect(archive({ sessionId: 's' })).toEqual({ sessionId: 's' })
    expect(archive({ sessionId: 's', subSessions: false })).toEqual({
      sessionId: 's',
      subSessions: false,
    })
    rejects(() => archive({ sessionId: 's', subSessions: 'false' }))
  })

  it('takes a session and a bounded task id for a background task', () => {
    for (const method of ['sessions.stopTask', 'sessions.taskOutput'] as const) {
      expect(posix[method]({ sessionId: 's', taskId: 'b1', other: 1 })).toEqual({
        sessionId: 's',
        taskId: 'b1',
      })
      rejects(() => posix[method]({ sessionId: 's' }))
      rejects(() => posix[method]({ sessionId: 's', taskId: '' }))
      rejects(() => posix[method]({ sessionId: 's', taskId: 'x'.repeat(257) }))
      rejects(() => posix[method]({ taskId: 'b1' }))
    }
  })

  it('takes a side question, its quote and the agent picked to answer it', () => {
    expect(posix['sessions.sideAsk']({ sessionId: 's', question: 'Why?', other: 1 })).toEqual({
      sessionId: 's',
      question: 'Why?',
    })
    expect(
      posix['sessions.sideAsk']({
        sessionId: 's',
        question: 'Why?',
        quote: 'This line',
        agentId: 'claude-code',
      }),
    ).toEqual({ sessionId: 's', question: 'Why?', quote: 'This line', agentId: 'claude-code' })
    rejects(() => posix['sessions.sideAsk']({ sessionId: 's', question: '  \n ' }))
    rejects(() => posix['sessions.sideAsk']({ sessionId: 's', question: 'x'.repeat(32_001) }))
    rejects(() => posix['sessions.sideAsk']({ sessionId: 's', question: 'Why?', quote: '' }))
    rejects(() => posix['sessions.sideAsk']({ sessionId: 's', question: 'Why?', agentId: 'nope!' }))
    expect(posix['sessions.sideClear']({ sessionId: 's', undo: true })).toEqual({
      sessionId: 's',
      undo: true,
    })
    expect(posix['sessions.sideClear']({ sessionId: 's', undo: false })).toEqual({ sessionId: 's' })
    rejects(() => posix['sessions.sideClear']({ sessionId: 's', undo: 'yes' }))
  })

  it('takes an auto-compact change of a whole number or null, for all models or one', () => {
    const change = { model: 'openai/gpt-6', value: 272000 }
    expect(posix['agents.setAutoCompact']({ agentId: 'pi', change, x: 1 })).toEqual({
      agentId: 'pi',
      change,
    })
    const all = { model: null, value: null }
    expect(posix['agents.setAutoCompact']({ agentId: 'codex', change: all })).toEqual({
      agentId: 'codex',
      change: all,
    })
    const bad = (change: unknown): void =>
      rejects(() => posix['agents.setAutoCompact']({ agentId: 'codex', change }))
    bad({ model: null, value: '272000' })
    bad({ model: null, value: 0.85 })
    bad({ model: '', value: 85 })
    bad({ value: 85 })
  })

  it('takes only the two Claude Code settings, each with a value of its own kind', () => {
    const window = { setting: 'autoCompactWindow', model: 'claude-sonnet-5-5', value: 200000 }
    expect(
      posix['agents.setClaudeSetting']({ agentId: 'claude-code', change: window, x: 1 }),
    ).toEqual({ agentId: 'claude-code', change: window })
    const ttl = { setting: 'promptCacheTtl', value: null }
    expect(posix['agents.setClaudeSetting']({ agentId: 'claude-code', change: ttl })).toEqual({
      agentId: 'claude-code',
      change: ttl,
    })
    const bad = (change: unknown): void =>
      rejects(() => posix['agents.setClaudeSetting']({ agentId: 'claude-code', change }))
    const all = { setting: 'autoCompactWindow', model: null, value: 300000 }
    expect(posix['agents.setClaudeSetting']({ agentId: 'claude-code', change: all })).toEqual({
      agentId: 'claude-code',
      change: all,
    })
    bad({ setting: 'env', value: 'x' })
    bad({ setting: 'promptCacheTtl', value: '2h' })
    bad({ setting: 'autoCompactWindow', model: 'claude-sonnet-5-5', value: '200000' })
    bad({ setting: 'autoCompactWindow', value: 200000 })
    bad({ setting: 'autoCompactWindow', model: '', value: 200000 })
    rejects(() => posix['agents.setClaudeSetting']({ agentId: 'claude-code' }))
  })

  it('takes only a site Settings offers for a Codebuddy Code agent', () => {
    for (const site of ['international', 'china', 'automatic']) {
      expect(
        posix['agents.setCodebuddySite']({
          agentId: 'codebuddy~work',
          change: { site, x: 1 },
        }),
      ).toEqual({ agentId: 'codebuddy~work', change: { site } })
    }
    const bad = (change: unknown): void =>
      rejects(() => posix['agents.setCodebuddySite']({ agentId: 'codebuddy', change }))
    bad({ site: 'internal' })
    bad({ site: 'ioa' })
    bad({ site: 1 })
    bad({})
    rejects(() => posix['agents.setCodebuddySite']({ agentId: 'codebuddy' }))
    expect(posix['agents.codebuddySettings']({ agentId: 'codebuddy~work' })).toEqual({
      agentId: 'codebuddy~work',
    })
  })

  it('checks the connection methods: servers Kettu keeps and logins of Connect', () => {
    expect(posix['market.connect']({ serverId: 'app.linear/linear' })).toEqual({
      serverId: 'app.linear/linear',
    })
    expect(
      posix['market.disconnect']({ serverId: 'manual:0f8fad5b-d9cb-469f-a165-70867728950e' }),
    ).toEqual({ serverId: 'manual:0f8fad5b-d9cb-469f-a165-70867728950e' })
    rejects(() => posix['market.connect']({ serverId: 'no slash' }))
    rejects(() => posix['market.connect']({}))
    expect(
      posix['market.cancelConnect']({ loginId: '0f8fad5b-d9cb-469f-a165-70867728950e' }),
    ).toEqual({ loginId: '0f8fad5b-d9cb-469f-a165-70867728950e' })
    rejects(() => posix['market.cancelConnect']({ loginId: 'anything' }))
    expect(posix['market.connections'](undefined)).toBeUndefined()
    rejects(() => posix['market.connections']({ serverId: 'x' }))
  })

  it('checks a URL being added and the headers its sign-in is asked with', () => {
    const detect = posix['market.detectSignIn']
    const url = 'https://mcp.example.com/mcp'
    const headers = [{ name: 'X-Team', value: 'a' }]
    expect(detect({ url, headers })).toEqual({ url, headers })
    expect(detect({ url: 'http://localhost:8788/mcp', headers: [] })).toEqual({
      url: 'http://localhost:8788/mcp',
      headers: [],
    })
    rejects(() => detect({ url: 'file:///etc/passwd', headers: [] }))
    rejects(() => detect({ url: 'https://mcp.example.com/a b', headers: [] }))
    rejects(() => detect({ url }))
    rejects(() => detect({ url, headers: [{ name: 'X-Team', value: 'a\r\nHost: evil' }] }))
    rejects(() => detect({ url, headers: [{ name: 'Bad Name', value: 'a' }] }))
    rejects(() =>
      detect({
        url,
        headers: [
          { name: 'Authorization', value: 'a' },
          { name: 'authorization', value: 'b' },
        ],
      }),
    )
    const many = Array.from({ length: 65 }, (_, i) => ({ name: `X-${i}`, value: '' }))
    rejects(() => detect({ url, headers: many }))
  })

  it("checks the Marketplace's catalog refresh and search query", () => {
    expect(posix['market.catalog'](undefined)).toEqual({})
    expect(posix['market.catalog']({})).toEqual({})
    expect(posix['market.catalog']({ refresh: true, other: 1 })).toEqual({ refresh: true })
    rejects(() => posix['market.catalog']({ refresh: 'yes' }))
    expect(posix['market.search']({ query: '  github  ' })).toEqual({ query: 'github' })
    expect(posix['market.search']({ query: 'x'.repeat(100) })).toEqual({ query: 'x'.repeat(100) })
    rejects(() => posix['market.search']({ query: ' gh ' }))
    rejects(() => posix['market.search']({ query: 'x'.repeat(101) }))
    rejects(() => posix['market.search']({ query: 'git\nhub' }))
    rejects(() => posix['market.search']({ query: 42 }))
    rejects(() => posix['market.search']({}))
    expect(posix['market.keys'](undefined)).toBeUndefined()
    rejects(() => posix['market.keys']({ serverId: 'x' }))
  })

  it('validates no method that managed harness plugins, and takes only refresh to list them', () => {
    for (const method of REMOVED_PLUGIN_METHODS) expect(posix).not.toHaveProperty([method])
    expect(posix['market.ownPlugins']({ refresh: true, other: 1 })).toEqual({ refresh: true })
    expect(posix['market.ownPlugins'](undefined)).toEqual({})
  })

  it('checks where a plugin comes from, and what names an installed or inspected one', () => {
    const inspect = (source: unknown) => posix['plugins.inspect']({ source })
    expect(inspect({ kind: 'local', path: '/home/me/plugin' })).toEqual({
      source: { kind: 'local', path: '/home/me/plugin' },
    })
    expect(inspect({ kind: 'github', url: 'https://github.com/a/b/tree/main/x' })).toEqual({
      source: { kind: 'github', url: 'https://github.com/a/b/tree/main/x' },
    })
    expect(inspect({ kind: 'kettu', id: 'abcdefgh23', extra: 1 })).toEqual({
      source: { kind: 'kettu', id: 'abcdefgh23' },
    })
    rejects(() => inspect({ kind: 'local', path: 'relative/plugin' }))
    rejects(() => inspect({ kind: 'github', url: 'https://example.com/a/b' }))
    rejects(() => inspect({ kind: 'kettu', id: '../x' }))
    rejects(() => inspect({ kind: 'catalog', id: 'a/b:c' }))
    rejects(() => inspect('https://github.com/a/b'))
    const token = '00000000-0000-4000-8000-000000000000'
    expect(posix['plugins.install']({ token })).toEqual({ token })
    rejects(() => posix['plugins.install']({ token: '../x' }))
    rejects(() => posix['plugins.discard']({}))
    const pluginId = 'p0123456789ab'
    expect(posix['plugins.setEnabled']({ pluginId, enabled: false })).toEqual({
      pluginId,
      enabled: false,
    })
    rejects(() => posix['plugins.setEnabled']({ pluginId }))
    for (const method of [
      'plugins.uninstall',
      'plugins.reload',
      'plugins.applyUpdate',
      'plugins.declineUpdate',
      'plugins.rollBack',
    ] as const) {
      expect(posix[method]({ pluginId })).toEqual({ pluginId })
      rejects(() => posix[method]({ pluginId: '../p0123456789ab' }))
      rejects(() => posix[method]({}))
    }
    expect(posix['plugins.checkUpdates'](undefined)).toEqual({})
    expect(posix['plugins.checkUpdates']({ pluginId })).toEqual({ pluginId })
    rejects(() => posix['plugins.checkUpdates']({ pluginId: 'x' }))
    expect(posix['plugins.resources']({ kind: 'roles' })).toEqual({ kind: 'roles' })
    rejects(() => posix['plugins.resources']({ kind: 'scripts' }))
  })

  it('checks which plugin view is opened and what an action sends', () => {
    const pluginId = 'p0123456789ab'
    expect(posix['plugins.viewData']({ pluginId, viewId: 'issues' })).toEqual({
      pluginId,
      viewId: 'issues',
      params: {},
    })
    expect(
      posix['plugins.viewData']({ pluginId, viewId: 'issue', params: { id: '3' } }).params,
    ).toEqual({ id: '3' })
    rejects(() => posix['plugins.viewData']({ pluginId, viewId: '../x' }))
    rejects(() => posix['plugins.viewData']({ pluginId: 'x', viewId: 'issues' }))
    rejects(() => posix['plugins.viewData']({ pluginId, viewId: 'issues', params: { id: 3 } }))
    expect(
      posix['plugins.viewAction']({
        pluginId,
        viewId: 'label',
        action: 'save',
        row: 'r1',
        values: { on: true, note: 'x' },
        junk: 1,
      }),
    ).toEqual({
      pluginId,
      viewId: 'label',
      params: {},
      action: 'save',
      row: 'r1',
      values: { on: true, note: 'x' },
    })
    rejects(() => posix['plugins.viewAction']({ pluginId, viewId: 'label' }))
    rejects(() => posix['plugins.viewAction']({ pluginId, viewId: 'label', action: 'a b' }))
    rejects(() =>
      posix['plugins.viewAction']({ pluginId, viewId: 'label', action: 'save', values: { a: 1 } }),
    )
  })

  it('checks which plugin action Search runs', () => {
    const pluginId = 'p0123456789ab'
    expect(posix['plugins.actionRun']({ pluginId, actionId: 'create', junk: 1 })).toEqual({
      pluginId,
      actionId: 'create',
    })
    rejects(() => posix['plugins.actionRun']({ pluginId }))
    rejects(() => posix['plugins.actionRun']({ pluginId, actionId: 'a b' }))
    rejects(() => posix['plugins.actionRun']({ pluginId: 'x', actionId: 'create' }))
  })

  it('checks where a skill to add comes from', () => {
    expect(posix['market.skills'](undefined)).toEqual({})
    const add = (source: unknown) => posix['market.addSkill']({ source })
    expect(add({ kind: 'catalog', id: 'anthropics/skills:pdf' })).toEqual({
      source: { kind: 'catalog', id: 'anthropics/skills:pdf' },
    })
    expect(add({ kind: 'github', url: 'https://github.com/a/b/tree/main/x' })).toEqual({
      source: { kind: 'github', url: 'https://github.com/a/b/tree/main/x' },
    })
    expect(add({ kind: 'local', path: '/home/me/skill' })).toEqual({
      source: { kind: 'local', path: '/home/me/skill' },
    })
    expect(add({ kind: 'catalog', id: 'trailofbits/skills:semgrep' })).toEqual({
      source: { kind: 'catalog', id: 'trailofbits/skills:semgrep' },
    })
    rejects(() => add({ kind: 'catalog', id: 'anthropics/skills:../x' }))
    rejects(() => add({ kind: 'catalog', id: '../skills:pdf' }))
    rejects(() => add({ kind: 'catalog', id: 'pdf' }))
    expect(posix['market.skillRepository']({ id: 'openai/skills', refresh: true })).toEqual({
      id: 'openai/skills',
      refresh: true,
    })
    rejects(() => posix['market.skillRepository']({ id: 'openai/../skills' }))
    rejects(() => posix['market.skillRepository']({ id: 'openai' }))
    rejects(() => add({ kind: 'github', url: 'https://example.com/a/b' }))
    rejects(() => add({ kind: 'local', path: 'relative/skill' }))
    rejects(() => add({ kind: 'npm', id: 'x' }))
    rejects(() => add('anthropics/skills:pdf'))
    expect(add({ kind: 'kettu', id: 'abcdefgh23' })).toEqual({
      source: { kind: 'kettu', id: 'abcdefgh23' },
    })
    rejects(() => add({ kind: 'kettu', id: '../../x' }))
    rejects(() => add({ kind: 'kettu', id: 'ABCDEFGH23' }))
  })

  it('checks the Kettu Marketplace’s requests', () => {
    expect(posix['market.community'](undefined)).toEqual({})
    expect(
      posix['market.community']({ q: ' notes ', kind: 'skill', cursor: 'c1', refresh: true }),
    ).toEqual({ q: 'notes', kind: 'skill', cursor: 'c1', refresh: true })
    rejects(() => posix['market.community']({ kind: 'theme' }))
    rejects(() => posix['market.community']({ q: 'a\nb' }))
    rejects(() => posix['market.community']({ q: 'x'.repeat(101) }))
    expect(posix['market.community']({ cursor: 'MTIuYWJjZGVmZ2gyMw' })).toEqual({
      cursor: 'MTIuYWJjZGVmZ2gyMw',
    })
    expect(posix['market.community']({ cursor: 'a+b/c=' })).toEqual({ cursor: 'a+b/c=' })
    for (const cursor of ['a?b', 'a&b=c', 'a#b', 'a%2F', 'a b', '..', '../x', 'x'.repeat(257)]) {
      rejects(() => posix['market.community']({ cursor }))
    }
    expect(posix['market.communityListing']({ id: 'abcdefgh23' })).toEqual({ id: 'abcdefgh23' })
    rejects(() => posix['market.communityListing']({ id: 'abc/../x' }))
    expect(posix['market.communityInstalled']({ refresh: true })).toEqual({ refresh: true })
    expect(posix['market.reportCommunity']({ id: 'abcdefgh23', message: ' Broken. ' })).toEqual({
      id: 'abcdefgh23',
      message: 'Broken.',
    })
    rejects(() => posix['market.reportCommunity']({ id: 'abcdefgh23', message: '   ' }))
    rejects(() => posix['market.reportCommunity']({ id: 'abcdefgh23', message: 'x'.repeat(2001) }))
    expect(posix['market.connect']({ serverId: 'kettu:abcdefgh23' })).toEqual({
      serverId: 'kettu:abcdefgh23',
    })
    rejects(() => posix['market.connect']({ serverId: 'kettu:../x' }))
  })

  it('checks the requests that install an MCP bundle', () => {
    const token = '0b6e3f8a-2c1d-4e5f-9a8b-7c6d5e4f3a2b'
    expect(posix['market.bundlePrepare']({ id: 'abcdefgh23' })).toEqual({ id: 'abcdefgh23' })
    rejects(() => posix['market.bundlePrepare']({ id: '../x' }))
    expect(posix['market.bundleCommit']({ token, values: { dir: '/a', n_2: '3' } })).toEqual({
      token,
      values: { dir: '/a', n_2: '3' },
    })
    rejects(() => posix['market.bundleCommit']({ token: '../partial', values: {} }))
    rejects(() => posix['market.bundleCommit']({ token, values: [] }))
    rejects(() => posix['market.bundleCommit']({ token, values: { 'a.b': 'x' } }))
    rejects(() => posix['market.bundleCommit']({ token, values: { dir: 1 } }))
    rejects(() => posix['market.bundleCommit']({ token, values: { dir: 'a\0b' } }))
    rejects(() => posix['market.bundleCommit']({ token, values: { dir: 'x'.repeat(16_385) } }))
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, 'x']))
    rejects(() => posix['market.bundleCommit']({ token, values: many }))
    expect(posix['market.bundleCancel']({ token })).toEqual({ token })
    rejects(() => posix['market.bundleCancel']({ token: token.toUpperCase() }))
  })

  it('checks the listing ids, versions and changes of Marketplace › Published', () => {
    expect(posix['market.account'](undefined)).toBeUndefined()
    expect(posix['market.published']({})).toBeUndefined()
    expect(posix['market.setPublisher']({ handle: 'amigoer' })).toEqual({ handle: 'amigoer' })
    rejects(() => posix['market.setPublisher']({ handle: 'Amigoer' }))
    rejects(() => posix['market.setPublisher']({ handle: '-x' }))

    const id = 'abcdefgh23'
    expect(posix['market.deleteListing']({ id, extra: 1 })).toEqual({ id })
    rejects(() => posix['market.deleteListing']({ id: '../mine' }))
    rejects(() => posix['market.deleteListing']({ id: 'ABCDEFGH23' }))
    expect(posix['market.withdrawVersion']({ id, version: '1.0.0-beta.1' })).toEqual({
      id,
      version: '1.0.0-beta.1',
    })
    rejects(() => posix['market.withdrawVersion']({ id, version: '../1.0.0' }))
    rejects(() => posix['market.versionFiles']({ id, version: 'latest' }))

    const update = (change: unknown) => posix['market.updateListing']({ id, change })
    expect(update({ visibility: 'unlisted', other: 'x' })).toEqual({
      id,
      change: { visibility: 'unlisted' },
    })
    expect(update({ name: 'Changelog writer', description: 'One line.', about: '' })).toEqual({
      id,
      change: { name: 'Changelog writer', description: 'One line.', about: '' },
    })
    rejects(() => update({}))
    rejects(() => update({ visibility: 'everyone' }))
    rejects(() => update({ name: '' }))
    rejects(() => update({ name: 'Two\nlines' }))
    rejects(() => update({ description: 'x'.repeat(121) }))
    rejects(() => update({ about: 'x'.repeat(4001) }))
  })

  it('takes only an absolute folder and a publish card’s own answers to publish from a folder', () => {
    expect(posix['market.checkFolder']({ path: '/home/me/skill' })).toEqual({
      path: '/home/me/skill',
    })
    expect(windows['market.checkFolder']({ path: 'C:\\skills\\x', draftId: 'd1' })).toEqual({
      path: 'C:\\skills\\x',
      draftId: 'd1',
    })
    rejects(() => posix['market.checkFolder']({ path: 'skills/x' }))
    rejects(() => posix['market.checkFolder']({ path: '/a\0b' }))
    const publish = (params: Record<string, unknown>) =>
      posix['market.publishFolder']({ path: '/home/me/skill', ...params })
    expect(publish({ visibility: 'private', notes: 'Fixes', handle: 'me', extra: 1 })).toEqual({
      path: '/home/me/skill',
      visibility: 'private',
      notes: 'Fixes',
      handle: 'me',
    })
    rejects(() => publish({ visibility: 'unlisted' }))
    rejects(() => publish({ notes: 'x'.repeat(4001) }))
    rejects(() => publish({ handle: 'Not A Handle' }))
    rejects(() => posix['market.publishFolder']({ path: 'relative' }))
  })

  it('validates provider actions without accepting unrelated credentials', () => {
    const base = { agentId: 'opencode', providerId: 'deepseek' }
    expect(posix['agents.providerAction']({ ...base, action: 'set-key', key: 'secret' })).toEqual({
      ...base,
      action: 'set-key',
      key: 'secret',
    })
    expect(
      posix['agents.providerAction']({ ...base, action: 'activate', credentialId: 'one' }),
    ).toEqual({
      ...base,
      action: 'activate',
      credentialId: 'one',
    })
    rejects(() => posix['agents.providerAction']({ ...base, action: 'delete' }))
    rejects(() => posix['agents.providerAction']({ ...base, action: 'set-key' }))
    rejects(() => posix['agents.providerAction']({ ...base, action: 'activate' }))
    rejects(() =>
      posix['agents.providerAction']({
        ...base,
        action: 'logout',
        credentialId: 'one',
        key: 'secret',
      }),
    )
    rejects(() =>
      posix['agents.providerAction']({
        ...base,
        providerId: '../other',
        action: 'logout',
        credentialId: 'one',
      }),
    )
  })

  it('takes one answer to a request: an option with a note, answers or form values', () => {
    const respond = posix['permissions.respond']
    const base = { sessionId: 's', requestId: 'r' }
    expect(respond({ ...base, optionId: 'reject', note: 'Shorter' })).toEqual({
      ...base,
      optionId: 'reject',
      note: 'Shorter',
    })
    expect(respond({ ...base, optionId: 'allow-once' })).toEqual({
      ...base,
      optionId: 'allow-once',
    })
    const values = { team: 'eng', count: 2, notify: false, tags: ['a', 'b'] }
    expect(respond({ ...base, values })).toEqual({ ...base, values })
    // A key JSON gives an object as its own stays one, never its prototype.
    const parsed = respond({ ...base, values: JSON.parse('{"__proto__": "x"}') }) as {
      values: Record<string, unknown>
    }
    expect(Object.getPrototypeOf(parsed.values)).toBe(Object.prototype)
    expect(Object.hasOwn(parsed.values, '__proto__')).toBe(true)
    rejects(() => respond(base))
    rejects(() => respond({ ...base, optionId: 'a', values }))
    rejects(() => respond({ ...base, answers: [], values }))
    rejects(() => respond({ ...base, values, note: 'x' }))
    rejects(() => respond({ ...base, optionId: 'a', note: 'x'.repeat(4001) }))
    rejects(() => respond({ ...base, optionId: 'a', note: 1 }))
    rejects(() => respond({ ...base, values: ['eng'] }))
    rejects(() => respond({ ...base, values: { '': 'x' } }))
    rejects(() => respond({ ...base, values: { ['k'.repeat(201)]: 'x' } }))
    rejects(() => respond({ ...base, values: { a: 'x'.repeat(10_001) } }))
    rejects(() => respond({ ...base, values: { a: Number.NaN } }))
    rejects(() => respond({ ...base, values: { a: null } }))
    rejects(() => respond({ ...base, values: { a: { b: 1 } } }))
    rejects(() => respond({ ...base, values: { a: [1] } }))
    rejects(() => respond({ ...base, values: { a: ['x'.repeat(1001)] } }))
    rejects(() => respond({ ...base, values: { a: Array.from({ length: 101 }, () => 'x') } }))
    rejects(() =>
      respond({
        ...base,
        values: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, 'x'])),
      }),
    )
  })

  it('wants absolute paths by the platform rules', () => {
    expect(posix['projects.add']({ path: '/Users/me/app' })).toEqual({ path: '/Users/me/app' })
    rejects(() => posix['projects.add']({ path: 'app' }))
    rejects(() => posix['projects.add']({ path: 'C:\\app' }))
    rejects(() => posix['projects.add']({ path: '/app\0/x' }))
    expect(windows['projects.add']({ path: 'C:\\app' })).toEqual({ path: 'C:\\app' })
    expect(windows['projects.add']({ path: '\\\\server\\share\\app' })).toMatchObject({})
    rejects(() => windows['projects.add']({ path: '\\app' }))
    rejects(() => windows['sessions.create']({ agentId: 'codex', projectPath: 'app' }))
  })

  it('requires an absolute project path and an explicit boolean for pinning', () => {
    const pin = posix['projects.pin']
    expect(pin({ path: '/repo', pinned: false })).toEqual({ path: '/repo', pinned: false })
    rejects(() => pin({ path: 'repo', pinned: true }))
    rejects(() => pin({ path: '/repo', pinned: 'true' }))
    rejects(() => pin({ path: '/repo' }))
    expect(pin({ path: null, pinned: true })).toEqual({ path: null, pinned: true })
    rejects(() => pin({ pinned: true }))
    rejects(() => pin({ path: null, pinned: 1 }))
  })

  it('requires absolute project paths, or null for the end, to move a project', () => {
    const move = posix['projects.move']
    expect(move({ path: '/a', before: '/b' })).toEqual({ path: '/a', before: '/b' })
    expect(move({ path: '/a', before: null })).toEqual({ path: '/a', before: null })
    rejects(() => move({ path: 'a', before: null }))
    rejects(() => move({ path: '/a', before: 'b' }))
    rejects(() => move({ path: '/a' }))
    rejects(() => move({ path: null, before: '/b' }))
    rejects(() => windows['projects.move']({ path: '/a', before: null }))
  })

  it('keeps optional fields out when absent', () => {
    expect(
      posix['sessions.create']({ agentId: 'codex', projectPath: '/p', parentId: undefined }),
    ).toEqual({ agentId: 'codex', projectPath: '/p' })
    expect(posix['sessions.create']({ agentId: 'codex', projectPath: null })).toEqual({
      agentId: 'codex',
      projectPath: null,
    })
    rejects(() => posix['sessions.create']({ agentId: 'codex' }))
    expect(
      posix['agents.listSessions']({ agentId: 'codex', projectPath: '/p', cursor: '10' }),
    ).toEqual({ agentId: 'codex', projectPath: '/p', cursor: '10' })
  })

  it('takes only positions and records that a page of requests gave', () => {
    const page = posix['sessions.modelRequests']
    expect(page({ sessionId: 's', before: '1048576' })).toEqual({
      sessionId: 's',
      before: '1048576',
    })
    // OpenCode's cursor, base64url JSON.
    const cursor = 'eyJpZCI6Im1zZ18xIiwib3JkZXIiOiJkZXNjIn0'
    expect(page({ sessionId: 's', before: cursor })).toEqual({ sessionId: 's', before: cursor })
    rejects(() => page({ sessionId: 's', before: '../x' }))
    rejects(() => page({ sessionId: 's', before: 'a?b=1' }))
    rejects(() => page({ sessionId: 's', before: 'a'.repeat(1025) }))

    const raw = posix['sessions.modelRequestRaw']
    const forked = 'msg_1f4cca296002HjLI6zKqIJOfL8_4'
    for (const handle of [
      'system',
      '0-120,300-512',
      'msg_1719e27e3001dJjIgtp6QtBkpk,msg_b2',
      forked,
      `msg_b2,${forked}`,
    ]) {
      expect(raw({ sessionId: 's', raw: handle })).toEqual({ sessionId: 's', raw: handle })
    }
    for (const handle of [
      'msg_',
      'msg_a/../b',
      '0-1,msg_a',
      'ses_a',
      '/api/session/x',
      'msg_a_4/../b',
      'msg_a.4',
      'msg_a_4,',
    ]) {
      rejects(() => raw({ sessionId: 's', raw: handle }))
    }
  })

  it('takes a forced plan limits read only as a flag', () => {
    const refresh = posix['agents.refreshLimits']
    expect(refresh({ agentId: 'codex' })).toEqual({ agentId: 'codex' })
    expect(refresh({ agentId: 'codex', force: true })).toEqual({ agentId: 'codex', force: true })
    rejects(() => refresh({ agentId: 'codex', force: 'yes' }))
    expect(refresh({ agentId: 'codex', force: true, extra: 1 })).toEqual({
      agentId: 'codex',
      force: true,
    })
  })

  it('takes a model to pin only with a model value and a pinned flag', () => {
    const pin = posix['agents.pinModel']
    expect(pin({ agentId: 'opencode', model: 'deepseek/deepseek-v4-pro', pinned: true })).toEqual({
      agentId: 'opencode',
      model: 'deepseek/deepseek-v4-pro',
      pinned: true,
    })
    rejects(() => pin({ agentId: 'opencode', model: '', pinned: true }))
    rejects(() => pin({ agentId: 'opencode', model: 'x'.repeat(4097), pinned: true }))
    rejects(() => pin({ agentId: 'opencode', model: 'opus', pinned: 'yes' }))
    rejects(() => pin({ agentId: 'opencode', model: 'opus' }))
    rejects(() => pin({ agentId: 'unknown-agent', model: 'opus', pinned: false }))
  })

  it('takes a reset credit to spend only with a credit id and a UUID v4 request id', () => {
    const spend = posix['agents.spendReset']
    const requestId = '0b0e7a52-6d0c-4a6e-9a3b-0d6f6f0c2a11'
    expect(spend({ agentId: 'codex', creditId: 'RateLimitResetCredit_abc-1', requestId })).toEqual({
      agentId: 'codex',
      creditId: 'RateLimitResetCredit_abc-1',
      requestId,
    })
    rejects(() => spend({ agentId: 'codex', creditId: '../consume?x=1', requestId }))
    rejects(() => spend({ agentId: 'codex', creditId: '', requestId }))
    rejects(() => spend({ agentId: 'codex', creditId: 'a', requestId: 'again' }))
    rejects(() => spend({ agentId: 'codex', creditId: 'a' }))
    rejects(() => spend({ agentId: 'nobody', creditId: 'a', requestId }))
  })

  it('checks a switch to another agent', () => {
    const switchAgent = posix['sessions.switchAgent']
    const content = [{ type: 'text', text: 'go on' }]
    expect(switchAgent({ sessionId: 's', agentId: 'codex', content, extra: 1 })).toEqual({
      sessionId: 's',
      agentId: 'codex',
      content,
    })
    expect(
      switchAgent({
        sessionId: 's',
        agentId: 'codex',
        content,
        options: { model: 'gpt-5.5', fast: true },
        summarize: true,
      }),
    ).toEqual({
      sessionId: 's',
      agentId: 'codex',
      content,
      options: { model: 'gpt-5.5', fast: true },
      summarize: true,
    })
    expect(switchAgent({ sessionId: 's', agentId: 'codex', content, summarize: false })).toEqual({
      sessionId: 's',
      agentId: 'codex',
      content,
    })
    rejects(() => switchAgent({ sessionId: 's', agentId: 'other', content }))
    rejects(() => switchAgent({ sessionId: 's', agentId: 'codex' }))
    rejects(() => switchAgent({ sessionId: 's', agentId: 'codex', content, summarize: 'yes' }))
    rejects(() => switchAgent({ sessionId: 's', agentId: 'codex', content, options: { a: {} } }))
    rejects(() => switchAgent({ agentId: 'codex', content }))
  })

  it('checks the file requests', () => {
    expect(posix['files.list']({ projectPath: '/p', extra: 1 })).toEqual({ projectPath: '/p' })
    rejects(() => posix['files.list']({ projectPath: 'p' }))

    const read = posix['files.read']
    expect(read({ projectPath: '/p', path: 'src/a.ts', extra: 1 })).toEqual({
      projectPath: '/p',
      path: 'src/a.ts',
    })
    expect(read({ projectPath: '/p', path: 'logo.svg', asText: true })).toEqual({
      projectPath: '/p',
      path: 'logo.svg',
      asText: true,
    })
    rejects(() => read({ projectPath: '/p', path: 'logo.svg', asText: 'yes' }))
    rejects(() => read({ projectPath: '/p' }))
    rejects(() => read({ projectPath: '/p', path: '' }))
    rejects(() => read({ projectPath: '/p', path: 3 }))
    rejects(() => read({ projectPath: '/p', path: '/etc/hosts' }))
    rejects(() => read({ projectPath: '/p', path: 'a\0b' }))
    rejects(() => read({ projectPath: '/p', path: 'x'.repeat(32_768) }))
    rejects(() => read({ projectPath: 'p', path: 'a.ts' }))
    rejects(() => windows['files.read']({ projectPath: 'C:\\p', path: 'C:\\Windows\\a.ini' }))
    rejects(() => windows['files.read']({ projectPath: 'C:\\p', path: '\\\\server\\share\\a' }))
    rejects(() => windows['files.read']({ projectPath: 'C:\\p', path: '\\Windows\\a.ini' }))
    expect(windows['files.read']({ projectPath: 'C:\\p', path: 'src/a.ts' })).toMatchObject({})

    // A thread may name any path; the host decides what it grants.
    const media = posix['media.open']
    expect(media({ projectPath: '/p', path: '/etc/a b.png', sessionId: 's', extra: 1 })).toEqual({
      projectPath: '/p',
      path: '/etc/a b.png',
      sessionId: 's',
    })
    rejects(() => media({ projectPath: '/p', path: '/a.png' }))
    rejects(() => media({ projectPath: 'p', path: '/a.png', sessionId: 's' }))
    rejects(() => media({ projectPath: '/p', path: 'a\0b.png', sessionId: 's' }))
    rejects(() => media({ projectPath: '/p', path: '', sessionId: 's' }))
    // A device's remote host may ask without a session, for a file in the project only.
    const authorize = posix['media.authorize']
    expect(authorize({ projectPath: '/p', path: 'a.png', extra: 1 })).toEqual({
      projectPath: '/p',
      path: 'a.png',
    })
    expect(authorize({ projectPath: '/p', path: '/a.png', sessionId: 's' })).toEqual({
      projectPath: '/p',
      path: '/a.png',
      sessionId: 's',
    })
    rejects(() => authorize({ projectPath: '/p', path: 'a.png', sessionId: 3 }))
    rejects(() => authorize({ projectPath: '/p', path: 'a.png', sessionId: '' }))
    rejects(() => authorize({ projectPath: '/p', path: 'a\0b.png' }))

    // An agent's own file names its session; the host decides whether it lies in its folder.
    const folder = posix['files.agentFolder']
    expect(folder({ sessionId: 's', extra: 1 })).toEqual({ sessionId: 's' })
    rejects(() => folder({}))
    rejects(() => folder({ sessionId: '' }))
    rejects(() => folder({ sessionId: 3 }))
    const own = posix['files.readAgentFile']
    expect(own({ sessionId: 's', path: '/Users/me/.gemini/plan.md', extra: 1 })).toEqual({
      sessionId: 's',
      path: '/Users/me/.gemini/plan.md',
    })
    rejects(() => own({ sessionId: 's', path: 'plan.md' }))
    rejects(() => own({ sessionId: 's', path: '' }))
    rejects(() => own({ sessionId: 's', path: '/a\0b.md' }))
    rejects(() => own({ sessionId: 's', path: `/${'x'.repeat(32_768)}` }))
    rejects(() => own({ sessionId: 's', path: 'file:///Users/me/plan.md' }))
    rejects(() => own({ path: '/a.md' }))
    rejects(() => own({ sessionId: '', path: '/a.md' }))
    rejects(() => windows['files.readAgentFile']({ sessionId: 's', path: '\\Users\\plan.md' }))
    expect(windows['files.readAgentFile']({ sessionId: 's', path: 'C:\\a\\plan.md' })).toEqual({
      sessionId: 's',
      path: 'C:\\a\\plan.md',
    })

    const search = posix['files.search']
    expect(search({ projectPath: '/p', query: 'needle', extra: 1 })).toEqual({
      projectPath: '/p',
      query: 'needle',
    })
    rejects(() => search({ projectPath: '/p', query: '' }))
    rejects(() => search({ projectPath: '/p', query: 'x'.repeat(4_097) }))
    rejects(() => search({ projectPath: '/p' }))
    rejects(() => search({ projectPath: 'p', query: 'x' }))

    const write = posix['files.write']
    expect(write({ projectPath: '/p', path: 'a.ts', text: 'x', version: 'v1', extra: 1 })).toEqual({
      projectPath: '/p',
      path: 'a.ts',
      text: 'x',
      version: 'v1',
    })
    expect(write({ projectPath: '/p', path: 'a.ts', text: '', version: null })).toMatchObject({
      text: '',
      version: null,
    })
    rejects(() => write({ projectPath: '/p', path: 'a.ts', text: 'x' }))
    rejects(() => write({ projectPath: '/p', path: 'a.ts', text: 1, version: null }))
    rejects(() => write({ projectPath: '/p', path: 'a.ts', text: 'x', version: '' }))
    rejects(() => write({ projectPath: '/p', path: '/etc/hosts', text: 'x', version: null }))
    rejects(() =>
      write({ projectPath: '/p', path: 'a.ts', text: 'x'.repeat(1024 * 1024 + 1), version: null }),
    )
  })

  it('checks the paths of file operations', () => {
    const create = posix['files.create']
    expect(create({ projectPath: '/p', path: 'a/b.ts', kind: 'file', extra: 1 })).toEqual({
      projectPath: '/p',
      path: 'a/b.ts',
      kind: 'file',
    })
    rejects(() => create({ projectPath: '/p', path: 'a', kind: 'link' }))
    rejects(() => create({ projectPath: '/p', path: '/etc/x', kind: 'file' }))
    rejects(() => create({ projectPath: 'p', path: 'a', kind: 'file' }))
    rejects(() => windows['files.create']({ projectPath: 'C:\\p', path: 'D:\\x', kind: 'file' }))

    const rename = posix['files.rename']
    expect(rename({ projectPath: '/p', from: 'a', to: 'b/a' })).toEqual({
      projectPath: '/p',
      from: 'a',
      to: 'b/a',
    })
    rejects(() => rename({ projectPath: '/p', from: 'a', to: '/b' }))
    rejects(() => rename({ projectPath: '/p', from: 'a\0', to: 'b' }))
    rejects(() => rename({ projectPath: '/p', from: 'a' }))

    const copy = posix['files.copy']
    expect(copy({ projectPath: '/p', paths: ['a', 'b/c'], folder: '' })).toEqual({
      projectPath: '/p',
      paths: ['a', 'b/c'],
      folder: '',
    })
    rejects(() => copy({ projectPath: '/p', paths: [], folder: '' }))
    rejects(() => copy({ projectPath: '/p', paths: ['/a'], folder: '' }))
    rejects(() => copy({ projectPath: '/p', paths: ['a'], folder: '/tmp' }))
    rejects(() => copy({ projectPath: '/p', paths: 'a', folder: '' }))

    const remove = posix['files.delete']
    expect(remove({ projectPath: '/p', paths: ['a'] })).toEqual({ projectPath: '/p', paths: ['a'] })
    expect(remove({ projectPath: '/p', paths: ['a'], permanently: true })).toMatchObject({
      permanently: true,
    })
    rejects(() => remove({ projectPath: '/p', paths: ['a'], permanently: 'yes' }))
    rejects(() => remove({ projectPath: '/p', paths: [1] }))
    rejects(() => remove({ projectPath: '/p', paths: ['/'] }))
    rejects(() => remove({ projectPath: '/p', paths: Array(10_001).fill('a') }))
  })
})

describe('routine requests', () => {
  const draft = {
    name: '',
    prompt: 'Summarize the open pull requests',
    agentId: 'claude-code',
    projectPath: null,
    options: [],
    trigger: { kind: 'schedule', schedule: { kind: 'weekly', days: [1], time: '09:00' } },
    scope: { level: 'read', web: false },
    timeLimitMinutes: 60,
  }

  it('keeps the sessions of 100 runs unless the draft chooses another of the choices', () => {
    expect(posix['routines.create'](draft)).toMatchObject({ keptRunSessions: 100 })
    expect(posix['routines.create']({ ...draft, keptRunSessions: 25 })).toMatchObject({
      keptRunSessions: 25,
    })
    rejects(() => posix['routines.create']({ ...draft, keptRunSessions: 30 }))
    rejects(() => posix['routines.create']({ ...draft, keptRunSessions: '100' }))
  })

  it('changes the kept run sessions only to one of the choices', () => {
    const routineId = 'r-0123456789ab'
    expect(posix['routines.update']({ routineId, changes: { keptRunSessions: 10 } })).toEqual({
      routineId,
      changes: { keptRunSessions: 10 },
    })
    rejects(() => posix['routines.update']({ routineId, changes: { keptRunSessions: 0 } }))
    rejects(() => posix['routines.update']({ routineId, changes: { keptRunSessions: 1000 } }))
  })
})

describe('promptContent', () => {
  const png = Buffer.from('fake image').toString('base64')

  it('keeps texts, images and links', () => {
    expect(
      promptContent([
        { type: 'text', text: 'Look' },
        { type: 'ref', ref: { kind: 'image', mimeType: 'image/png', data: png } },
        { type: 'ref', ref: { kind: 'link', uri: 'file:///a.ts', name: 'a.ts', extra: 1 } },
      ]),
    ).toEqual([
      { type: 'text', text: 'Look' },
      { type: 'ref', ref: { kind: 'image', mimeType: 'image/png', data: png } },
      { type: 'ref', ref: { kind: 'link', uri: 'file:///a.ts', name: 'a.ts' } },
    ])
  })

  it('keeps a browser tab and a device the user referenced by their ids and names alone', () => {
    expect(
      promptContent([
        { type: 'text', text: 'Look at @page:t4 on @device:0E02CA7B' },
        { type: 'ref', ref: { kind: 'page', tabId: 't4', name: 'Mail', url: 'x' } },
        { type: 'ref', ref: { kind: 'device', deviceId: 'ios-sim:0E02', name: 'iPhone 17' } },
      ]),
    ).toEqual([
      { type: 'text', text: 'Look at @page:t4 on @device:0E02CA7B' },
      { type: 'ref', ref: { kind: 'page', tabId: 't4', name: 'Mail' } },
      { type: 'ref', ref: { kind: 'device', deviceId: 'ios-sim:0E02', name: 'iPhone 17' } },
    ])
    rejects(() =>
      promptContent([
        { type: 'text', text: 'x' },
        { type: 'ref', ref: { kind: 'page', name: 'x' } },
      ]),
    )
  })

  it('keeps a terminal the user referenced by its id and name alone', () => {
    expect(
      promptContent([
        { type: 'text', text: 'Carry on in @terminal:3fa2c1d0' },
        { type: 'ref', ref: { kind: 'terminal', terminalId: 't-1', name: 'pnpm dev', run: 'x' } },
      ]),
    ).toEqual([
      { type: 'text', text: 'Carry on in @terminal:3fa2c1d0' },
      { type: 'ref', ref: { kind: 'terminal', terminalId: 't-1', name: 'pnpm dev' } },
    ])
    rejects(() =>
      promptContent([
        { type: 'text', text: 'x' },
        { type: 'ref', ref: { kind: 'terminal', terminalId: 't-1', name: 'n'.repeat(257) } },
      ]),
    )
    rejects(() =>
      promptContent([
        { type: 'text', text: 'x' },
        { type: 'ref', ref: { kind: 'terminal', name: 'zsh' } },
      ]),
    )
  })

  it('rejects empty prompts and content the agent cannot take', () => {
    rejects(() => promptContent([]))
    rejects(() => promptContent([{ type: 'text', text: '   ' }]))
    rejects(() => promptContent('hello'))
    rejects(() => promptContent([{ type: 'audio' }]))
    rejects(() => promptContent([{ type: 'ref', ref: { kind: 'unsupported', label: 'x' } }]))
    rejects(() =>
      promptContent([{ type: 'ref', ref: { kind: 'image', mimeType: 'text/html', data: png } }]),
    )
    rejects(() =>
      promptContent([{ type: 'ref', ref: { kind: 'image', mimeType: 'image/png', data: '<>' } }]),
    )
  })

  it('limits the prompt to 10 MB in all', () => {
    const half = 'a'.repeat(5 * 1024 * 1024)
    expect(promptContent([{ type: 'text', text: half }])).toHaveLength(1)
    rejects(() =>
      promptContent([
        { type: 'text', text: half },
        { type: 'text', text: half },
        { type: 'text', text: 'one more byte' },
      ]),
    )
    // Counted in UTF-8 bytes, not characters.
    rejects(() => promptContent([{ type: 'text', text: '\u00e9'.repeat(5 * 1024 * 1024 + 1) }]))
  })
})

describe('attachments', () => {
  const ref = (id: string, extra: Record<string, unknown> = {}) => ({
    type: 'ref',
    ref: { kind: 'attachment', attachment: { id, ...extra } },
  })

  it('reads only the id of an attachment ref', () => {
    const [item] = promptContent([ref('a1', { name: 'secret.png', uri: 'file:///etc/passwd' })])
    expect(item).toEqual({
      type: 'ref',
      ref: {
        kind: 'attachment',
        attachment: {
          id: 'a1',
          type: 'image',
          name: '',
          uri: null,
          mimeType: null,
          size: null,
          sent: null,
          thumb: null,
          blob: null,
        },
      },
    })
    // A message of attachments alone can be sent.
    expect(promptContent([ref('a1'), ref('a2')])).toHaveLength(2)
    rejects(() => promptContent([{ type: 'ref', ref: { kind: 'attachment' } }]))
    rejects(() => promptContent([ref('')]))
  })

  it('takes at most 20 attachments in a prompt', () => {
    const refs = Array.from({ length: 20 }, (_, i) => ref(`a${i}`))
    expect(promptContent(refs)).toHaveLength(20)
    rejects(() => promptContent([...refs, ref('a20')]))
  })

  it('checks what attachments.add is handed', () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer
    const source = { bytes, mimeType: 'image/png', name: 'Image 1' }
    const thumb = 'data:image/webp;base64,AAAA'
    expect(posix['attachments.add']({ source: { ...source, path: '/x' }, thumb })).toEqual({
      source,
      thumb,
    })
    expect(posix['attachments.add']({ source, thumb: null })).toEqual({ source, thumb: null })
    rejects(() => posix['attachments.add']({ source: { ...source, bytes: [1, 2, 3] }, thumb }))
    rejects(() => posix['attachments.add']({ source: { ...source, bytes: new ArrayBuffer(0) } }))
    rejects(() =>
      posix['attachments.add']({
        source: { ...source, bytes: new ArrayBuffer(20 * 1024 * 1024 + 1) },
        thumb,
      }),
    )
    rejects(() => posix['attachments.add']({ source, thumb: 'https://example.com/t.png' }))
    rejects(() => posix['attachments.add']({ source, thumb: 'data:image/svg+xml;base64,AAAA' }))
    rejects(() =>
      posix['attachments.add']({ source, thumb: `data:image/webp;base64,${'A'.repeat(300_000)}` }),
    )
  })

  it('takes a grant by its id alone, never a path', () => {
    const thumb = 'data:image/webp;base64,AAAA'
    expect(
      posix['attachments.add']({ source: { grantId: 'g1', path: '/etc/passwd' }, thumb: null }),
    ).toEqual({ source: { grantId: 'g1' }, thumb: null })
    expect(
      posix['attachments.add']({
        source: { grantId: 'g1', bytes: new Uint8Array([1]).buffer },
        thumb,
      }),
    ).toEqual({ source: { grantId: 'g1' }, thumb })
    rejects(() => posix['attachments.add']({ source: { grantId: 7 }, thumb: null }))
    rejects(() => posix['attachments.add']({ source: { path: '/etc/passwd' }, thumb: null }))
  })

  it('takes a mention as a path relative to an absolute project path', () => {
    const source = { projectPath: '/work/app', path: 'src/a.ts' }
    expect(posix['attachments.add']({ source, thumb: null })).toEqual({ source, thumb: null })
    expect(
      posix['attachments.add']({
        source: { ...source, bytes: new Uint8Array([1]).buffer },
        thumb: null,
      }),
    ).toEqual({ source, thumb: null })
    rejects(() =>
      posix['attachments.add']({ source: { ...source, path: '/etc/passwd' }, thumb: null }),
    )
    rejects(() =>
      posix['attachments.add']({ source: { ...source, projectPath: 'app' }, thumb: null }),
    )
    rejects(() => posix['attachments.add']({ source: { projectPath: '/work/app' }, thumb: null }))
  })

  it('checks what attachments.update is handed', () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer
    const thumb = 'data:image/webp;base64,AAAA'
    expect(posix['attachments.update']({ id: 'a1', thumb, scaled: null })).toEqual({
      id: 'a1',
      thumb,
      scaled: null,
    })
    expect(
      posix['attachments.update']({
        id: 'a1',
        thumb: null,
        scaled: { bytes, mimeType: 'image/jpeg', path: '/x' },
      }),
    ).toEqual({ id: 'a1', thumb: null, scaled: { bytes, mimeType: 'image/jpeg' } })
    rejects(() => posix['attachments.update']({ id: 'a1', thumb }))
    rejects(() => posix['attachments.update']({ id: 'a1', thumb: 'x', scaled: null }))
    rejects(() =>
      posix['attachments.update']({
        id: 'a1',
        thumb,
        scaled: { bytes: [1], mimeType: 'image/png' },
      }),
    )
    rejects(() =>
      posix['attachments.update']({
        id: 'a1',
        thumb,
        scaled: { bytes: new ArrayBuffer(20 * 1024 * 1024 + 1), mimeType: 'image/png' },
      }),
    )
  })

  it('reads a sent blob only by its SHA-256', () => {
    const hash = 'ab'.repeat(32)
    expect(posix['sessions.blob']({ sessionId: 's', hash })).toEqual({ sessionId: 's', hash })
    rejects(() => posix['sessions.blob']({ sessionId: 's', hash: '../../etc/passwd' }))
    rejects(() => posix['sessions.blob']({ sessionId: 's', hash: hash.toUpperCase() }))
    rejects(() => posix['sessions.blob']({ hash }))
    expect(posix['sessions.entry']({ sessionId: 's', entryId: 'toolu_1', more: 1 })).toEqual({
      sessionId: 's',
      entryId: 'toolu_1',
    })
    rejects(() => posix['sessions.entry']({ sessionId: 's' }))
    rejects(() => posix['sessions.entry']({ sessionId: 's', entryId: 'x'.repeat(1025) }))
    expect(posix['sessions.requests']({ sessionId: 's', more: 1 })).toEqual({ sessionId: 's' })
    rejects(() => posix['sessions.requests']({}))
    expect(posix['attachments.read']({ id: 'a1', more: 1 })).toEqual({ id: 'a1' })
    rejects(() => posix['attachments.remove']({}))
    expect(posix['attachments.held']({ ids: ['a1', 'a2'] })).toEqual({ ids: ['a1', 'a2'] })
    rejects(() => posix['attachments.held']({ ids: 'a1' }))
    rejects(() => posix['attachments.held']({ ids: ['a1', ''] }))
  })
})

describe('attaching a session while the user types', () => {
  it('takes the session id alone, so nothing can be sent with it', () => {
    expect(posix['sessions.attachEarly']({ sessionId: 's', content: [] })).toEqual({
      sessionId: 's',
    })
    rejects(() => posix['sessions.attachEarly']({}))
    rejects(() => posix['sessions.attachEarly']({ sessionId: 1 }))
    rejects(() => posix['sessions.attachEarly']({ sessionId: 'x'.repeat(257) }))
  })
})

describe('comment and direct edit requests', () => {
  const id = 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D3'
  const anchor = {
    version: 2,
    path: 'index.html',
    page: { number: 1, name: 'General' },
    offset: 10,
    tag: 'button',
    text: 'Save',
    missing: true,
  }

  it('takes an anchor as the page reported it, never already missing', () => {
    expect(posix['artifacts.comment']({ id, anchor, body: 'Hi' })).toEqual({
      id,
      anchor: { ...anchor, missing: false },
      body: 'Hi',
    })
    rejects(() =>
      posix['artifacts.comment']({ id, anchor: { ...anchor, path: 'a.css' }, body: 'x' }),
    )
    rejects(() =>
      posix['artifacts.comment']({ id, anchor: { ...anchor, path: '../a.html' }, body: 'x' }),
    )
    rejects(() => posix['artifacts.comment']({ id, anchor: { ...anchor, tag: '<b>' }, body: 'x' }))
    rejects(() =>
      posix['artifacts.comment']({ id, anchor: { ...anchor, text: 'x'.repeat(121) }, body: 'x' }),
    )
    rejects(() => posix['artifacts.comment']({ id, anchor, body: '  ' }))
  })

  it("takes an anchor on a document's block in its Markdown, and no other Markdown file", () => {
    const block = { ...anchor, path: 'document.md', page: null, tag: 'p', text: 'Between' }
    expect(posix['artifacts.comment']({ id, anchor: block, body: 'Hi' })).toEqual({
      id,
      anchor: { ...block, missing: false },
      body: 'Hi',
    })
    rejects(() =>
      posix['artifacts.comment']({ id, anchor: { ...block, path: 'notes.md' }, body: 'x' }),
    )
  })

  it('pins a thread again only to an anchor as the page reported it', () => {
    const threadId = 'thr_01J9Z3K4V5W6X7Y8Z9A0B1C2D3'
    expect(posix['artifacts.repin']({ id, threadId, anchor })).toEqual({
      id,
      threadId,
      anchor: { ...anchor, missing: false },
    })
    rejects(() => posix['artifacts.repin']({ id, threadId: 'thr_x', anchor }))
    rejects(() =>
      posix['artifacts.repin']({ id, threadId, anchor: { ...anchor, path: '../a.html' } }),
    )
  })

  it('takes an edit of the editable properties only, to values that stay in the attribute', () => {
    const edit = { id, baseVersion: 3, path: 'index.html', offset: 0, text: null }
    expect(posix['artifacts.editElement']({ ...edit, style: { color: '#ffffff' } })).toEqual({
      ...edit,
      style: { color: '#ffffff' },
    })
    rejects(() => posix['artifacts.editElement']({ ...edit, style: { color: 'red;x:y' } }))
    rejects(() => posix['artifacts.editElement']({ ...edit, style: { position: 'fixed' } }))
    rejects(() => posix['artifacts.editElement']({ ...edit, style: null }))
    rejects(() => posix['artifacts.editElement']({ ...edit, style: null, text: 5 }))
    rejects(() => posix['artifacts.editElement']({ ...edit, offset: -1, style: null, text: 'x' }))
    rejects(() => posix['artifacts.markSent']({ id, threadIds: ['nope'], sessionId: 's' }))
  })

  it('takes a seen version and the versions to compare as version numbers only', () => {
    expect(posix['artifacts.seen']({ id, version: 4 })).toEqual({ id, version: 4 })
    rejects(() => posix['artifacts.seen']({ id, version: 0 }))
    rejects(() => posix['artifacts.seen']({ id, version: 1.5 }))
    rejects(() => posix['artifacts.seen']({ id: 'art_x', version: 1 }))
    expect(posix['artifacts.changes']({ id, from: 3, to: 1 })).toEqual({ id, from: 3, to: 1 })
    rejects(() => posix['artifacts.changes']({ id, from: 2, to: 2 }))
  })

  it('takes a usage summary by hour of the day only over zones that cover it', () => {
    const base = { dayStarts: [0, 900_000], from: 0, to: 900_000, scope: 'computer' }
    expect(posix['usage.summary'](base)).toEqual(base)
    const zones = [
      { from: 0, offset: -240 },
      { from: 900_000 * 4, offset: -300 },
    ]
    const clock = { from: 0, to: 900_000 * 8, zones }
    expect(posix['usage.summary']({ ...base, clock })).toEqual({ ...base, clock })
    const summary = (patch: object) => () =>
      posix['usage.summary']({ ...base, clock: { ...clock, ...patch } })
    rejects(summary({ zones: [] }))
    rejects(
      summary({ zones: Array.from({ length: 257 }, (_, i) => ({ from: i * 900_000, offset: 0 })) }),
    )
    rejects(summary({ zones: [{ from: 0, offset: 7 }] }))
    rejects(summary({ zones: [{ from: 0, offset: 900 }] }))
    rejects(summary({ zones: [{ from: 0, offset: -735 }] }))
    rejects(summary({ zones: [{ from: 60_000, offset: 0 }] }))
    rejects(
      summary({
        zones: [
          { from: 0, offset: 0 },
          { from: 0, offset: 60 },
        ],
      }),
    )
    rejects(summary({ from: 900_000, zones: [{ from: 900_000 * 2, offset: 0 }] }))
    rejects(summary({ to: -1 }))
    rejects(() => posix['usage.summary']({ ...base, clock: 'all' }))
  })
})

describe('surface control requests', () => {
  it('takes Done or Skip on a step card and the time a page was held', () => {
    expect(posix['control.answerAsk']({ sessionId: 's', entryId: 'e:1', outcome: 'done' })).toEqual(
      { sessionId: 's', entryId: 'e:1', outcome: 'done' },
    )
    expect(posix['browser.handedBack']({ sessionId: 's', durationMs: 72_000 })).toEqual({
      sessionId: 's',
      durationMs: 72_000,
    })
  })

  it('refuses another outcome, a missing entry or a time that is not one', () => {
    rejects(() => posix['control.answerAsk']({ sessionId: 's', entryId: 'e', outcome: 'ended' }))
    rejects(() => posix['control.answerAsk']({ sessionId: 's', outcome: 'done' }))
    rejects(() => posix['browser.handedBack']({ sessionId: 's', durationMs: -1 }))
    rejects(() => posix['browser.handedBack']({ sessionId: 's', durationMs: 1.5 }))
    rejects(() => posix['browser.handedBack']({ durationMs: 10 }))
  })
})

describe('computer use requests', () => {
  it('takes an answer to an app card and Stop', () => {
    expect(
      posix['computer.answerApp']({ sessionId: 's', entryId: 'e:1', decision: 'always' }),
    ).toEqual({ sessionId: 's', entryId: 'e:1', decision: 'always' })
    expect(posix['computer.stop']({ sessionId: 's' })).toEqual({ sessionId: 's' })
    expect(posix['computer.declineSetup']({ sessionId: 's', entryId: 'e:2' })).toEqual({
      sessionId: 's',
      entryId: 'e:2',
    })
  })

  it('refuses another answer or a missing session', () => {
    rejects(() =>
      posix['computer.answerApp']({ sessionId: 's', entryId: 'e', decision: 'project' }),
    )
    rejects(() => posix['computer.answerApp']({ entryId: 'e', decision: 'deny' }))
    rejects(() => posix['computer.stop']({}))
    rejects(() => posix['computer.declineSetup']({ sessionId: 's' }))
    rejects(() => posix['computer.declineSetup']({ entryId: 'e:2' }))
    rejects(() => posix['computer.declineSetup']({ sessionId: 's', entryId: 7 }))
  })

  it("takes an answer to a card holding a folder's own MCP servers", () => {
    for (const decision of ['use', 'all', 'skip']) {
      expect(
        posix['sessions.answerProjectMcp']({ sessionId: 's', entryId: 'e:1', decision }),
      ).toEqual({ sessionId: 's', entryId: 'e:1', decision })
    }
    rejects(() =>
      posix['sessions.answerProjectMcp']({ sessionId: 's', entryId: 'e:1', decision: 'timeout' }),
    )
    rejects(() => posix['sessions.answerProjectMcp']({ entryId: 'e:1', decision: 'use' }))
    rejects(() => posix['sessions.answerProjectMcp']({ sessionId: 's', decision: 'use' }))
  })

  it("takes an answer to a card holding a folder's own hooks", () => {
    for (const decision of ['use', 'all', 'skip']) {
      expect(
        posix['sessions.answerProjectHooks']({ sessionId: 's', entryId: 'e:1', decision }),
      ).toEqual({ sessionId: 's', entryId: 'e:1', decision })
    }
    rejects(() =>
      posix['sessions.answerProjectHooks']({ sessionId: 's', entryId: 'e:1', decision: 'timeout' }),
    )
    rejects(() => posix['sessions.answerProjectHooks']({ entryId: 'e:1', decision: 'use' }))
    rejects(() => posix['sessions.answerProjectHooks']({ sessionId: 's', decision: 'use' }))
  })

  it('takes the screen a git watch belongs to', () => {
    for (const method of ['git.status', 'git.unwatch'] as const) {
      expect(posix[method]({ projectPath: '/p' })).toEqual({ projectPath: '/p' })
      expect(posix[method]({ projectPath: '/p', watcher: 'files', extra: 1 })).toEqual({
        projectPath: '/p',
        watcher: 'files',
      })
      rejects(() => posix[method]({ projectPath: '/p', watcher: '' }))
      rejects(() => posix[method]({ projectPath: '/p', watcher: 7 }))
      rejects(() => posix[method]({ projectPath: '/p', watcher: 'x'.repeat(257) }))
    }
  })

  it('takes only a branch name as the base of a drafted pull request', () => {
    expect(posix['git.pullRequestDraft']({ projectPath: '/p', base: 'main' })).toEqual({
      projectPath: '/p',
      base: 'main',
    })
    expect(posix['git.pullRequestDraft']({ projectPath: '/p', base: 'feat/a-b' }).base).toBe(
      'feat/a-b',
    )
    rejects(() => posix['git.pullRequestDraft']({ projectPath: '/p' }))
    rejects(() => posix['git.pullRequestDraft']({ projectPath: '/p', base: '' }))
    rejects(() => posix['git.pullRequestDraft']({ projectPath: '/p', base: '--output=x' }))
    rejects(() => posix['git.pullRequestDraft']({ projectPath: '/p', base: 'main dev' }))
    rejects(() => posix['git.pullRequestDraft']({ projectPath: 'p', base: 'main' }))
  })

  it('takes what became of a drafted problem report', () => {
    const sent = { kind: 'sent', reportId: 'R-7K2F' }
    expect(
      posix['sessions.answerReport']({ sessionId: 's', entryId: 'e:1', outcome: sent }),
    ).toEqual({ sessionId: 's', entryId: 'e:1', outcome: sent })
    for (const kind of ['saved', 'skipped']) {
      expect(
        posix['sessions.answerReport']({ sessionId: 's', entryId: 'e:1', outcome: { kind } }),
      ).toEqual({ sessionId: 's', entryId: 'e:1', outcome: { kind } })
    }
    rejects(() =>
      posix['sessions.answerReport']({ sessionId: 's', entryId: 'e:1', outcome: { kind: 'sent' } }),
    )
    rejects(() =>
      posix['sessions.answerReport']({ sessionId: 's', entryId: 'e:1', outcome: 'skipped' }),
    )
    rejects(() =>
      posix['sessions.answerReport']({ sessionId: 's', entryId: 'e:1', outcome: { kind: 'lost' } }),
    )
    rejects(() => posix['sessions.answerReport']({ entryId: 'e:1', outcome: { kind: 'saved' } }))
  })

  it('reads issues only from github.com issue addresses', () => {
    const url = 'https://github.com/KettuAI/Kettu/issues/546'
    expect(posix['git.issue']({ url })).toEqual({ url })
    rejects(() => posix['git.issue']({}))
    rejects(() => posix['git.issue']({ url: 'https://github.com/KettuAI/Kettu/pull/546' }))
    rejects(() => posix['git.issue']({ url: 'http://github.com/KettuAI/Kettu/issues/546' }))
    rejects(() => posix['git.issue']({ url: 'https://github.example.com/a/b/issues/1' }))
    rejects(() => posix['git.issue']({ url: 'https://github.com/a/b/issues/1?x=--repo' }))
    rejects(() => posix['git.issue']({ url: 'https://github.com/a/b/issues/1/../../x' }))
    rejects(() => posix['git.issue']({ url: 'https://github.com/-a/b/issues/1' }))
    rejects(() => posix['git.issue']({ url: 'https://github.com/a/../issues/1' }))
    rejects(() => posix['git.issue']({ url: 'https://github.com/a/b/issues/0' }))
    rejects(() => posix['git.issue']({ url: `${url}\n` }))
  })

  it('watches only github.com pull request and issue addresses, a bounded number', () => {
    const pull = 'https://github.com/KettuAI/Kettu/pull/546'
    const issue = 'https://github.com/KettuAI/Kettu/issues/546'
    expect(posix['git.watchReferences']({ urls: [pull, issue] })).toEqual({ urls: [pull, issue] })
    expect(posix['git.watchReferences']({ urls: [] })).toEqual({ urls: [] })
    rejects(() => posix['git.watchReferences']({}))
    rejects(() => posix['git.watchReferences']({ urls: pull }))
    rejects(() => posix['git.watchReferences']({ urls: [pull, 7] }))
    rejects(() => posix['git.watchReferences']({ urls: ['https://github.com/a/b/commit/1'] }))
    rejects(() => posix['git.watchReferences']({ urls: ['http://github.com/a/b/pull/1'] }))
    rejects(() => posix['git.watchReferences']({ urls: ['https://github.example.com/a/b/pull/1'] }))
    rejects(() =>
      posix['git.watchReferences']({ urls: ['https://github.com/a/b/pull/1?x=--repo'] }),
    )
    rejects(() => posix['git.watchReferences']({ urls: [`${pull}\n`] }))
    rejects(() => posix['git.watchReferences']({ urls: Array.from({ length: 101 }, () => pull) }))
    expect(
      posix['git.watchReferences']({ urls: Array.from({ length: 100 }, () => pull) }).urls,
    ).toHaveLength(100)
  })
})

describe('memory requests', () => {
  const project = { layer: 'project', project: '/repo' }
  const draft = { title: 'Runs tests with pnpm', description: '', body: 'pnpm test <file>' }

  it('takes a scope of the global layer or of a project by its absolute path', () => {
    expect(posix['memory.list']({ scope: { layer: 'global' } })).toEqual({
      scope: { layer: 'global' },
    })
    expect(posix['memory.list']({ scope: project })).toEqual({ scope: project })
    rejects(() => posix['memory.list']({ scope: { layer: 'project', project: 'repo' } }))
    rejects(() => posix['memory.list']({ scope: { layer: 'project' } }))
    rejects(() => posix['memory.list']({ scope: { layer: 'global', project: '/repo' } }))
    rejects(() => posix['memory.list']({ scope: { layer: 'user' } }))
    expect(windows['memory.list']({ scope: { layer: 'project', project: 'C:\\repo' } })).toEqual({
      scope: { layer: 'project', project: 'C:\\repo' },
    })
  })

  it('saves a draft within the limits, as a new entry or an existing one by its id', () => {
    expect(posix['memory.save']({ scope: project, id: null, draft })).toEqual({
      scope: project,
      id: null,
      draft,
    })
    expect(posix['memory.save']({ scope: project, id: 'runs-tests', draft })).toEqual({
      scope: project,
      id: 'runs-tests',
      draft,
    })
    rejects(() => posix['memory.save']({ scope: project, id: '../x', draft }))
    rejects(() =>
      posix['memory.save']({ scope: project, id: null, draft: { ...draft, title: ' ' } }),
    )
    rejects(() =>
      posix['memory.save']({
        scope: project,
        id: null,
        draft: { ...draft, title: 'x'.repeat(81) },
      }),
    )
    rejects(() =>
      posix['memory.save']({
        scope: project,
        id: null,
        draft: { ...draft, body: 'x'.repeat(8001) },
      }),
    )
    rejects(() => posix['memory.save']({ scope: project, id: null, draft: { title: 'x' } }))
    rejects(() => posix['memory.remove']({ scope: project, id: 'A' }))
    rejects(() => posix['memory.moveToGlobal']({ project: 'repo', id: 'runs-tests' }))
  })

  it('takes an answer to a proposed global write and an Undo', () => {
    for (const decision of ['remember', 'skip']) {
      expect(posix['sessions.answerMemory']({ sessionId: 's', entryId: 'e:1', decision })).toEqual({
        sessionId: 's',
        entryId: 'e:1',
        decision,
      })
    }
    rejects(() =>
      posix['sessions.answerMemory']({ sessionId: 's', entryId: 'e:1', decision: 'accept' }),
    )
    expect(posix['sessions.undoMemory']({ sessionId: 's', entryId: 'e:1', other: 1 })).toEqual({
      sessionId: 's',
      entryId: 'e:1',
    })
    rejects(() => posix['sessions.undoMemory']({ sessionId: 's' }))
  })

  it('imports only known agents and absolute project paths', () => {
    const sources = [{ agentId: 'claude-code', project: '/repo' }]
    expect(posix['memory.import']({ sources, global: ['k1'] })).toEqual({
      sources,
      global: ['k1'],
    })
    rejects(() => posix['memory.import']({ sources: [{ agentId: 'other', project: '/repo' }] }))
    rejects(() =>
      posix['memory.import']({ sources: [{ agentId: 'codex', project: 'repo' }], global: [] }),
    )
    rejects(() => posix['memory.import']({ sources, global: [7] }))
    rejects(() => posix['memory.setEnabled']({ enabled: 'yes' }))
  })
})

describe('worktree requests', () => {
  const settings = {
    branchTemplate: '{type}/{issue}-{slug}',
    copy: ['.env', '.claude/settings.local.json'],
    setup: 'pnpm install',
    waitForSetup: true,
  }

  it('takes a base and a branch for a new session, and refuses what git would read otherwise', () => {
    const create = (worktree: unknown) =>
      posix['sessions.create']({ agentId: 'codex', projectPath: '/repo', worktree })
    expect(create({ base: 'main', branch: 'kettu/fix-login' })).toMatchObject({
      worktree: { base: 'main', branch: 'kettu/fix-login' },
    })
    expect(create({ base: 'refs/heads/feat/x' })).toMatchObject({
      worktree: { base: 'refs/heads/feat/x' },
    })
    for (const base of ['-x', '--all', 'main~1', 'a b', 'main\0', 'HEAD:path', '']) {
      rejects(() => create({ base }))
    }
    for (const branch of ['-b', 'a..b', 'a@{1}', 'x.lock', 'a b', 'x'.repeat(101), 'HEAD']) {
      rejects(() => create({ base: 'main', branch }))
    }
    rejects(() => create('main'))
  })

  it('forks into a new or the same worktree only', () => {
    expect(posix['sessions.fork']({ sessionId: 's', worktree: 'same' })).toEqual({
      sessionId: 's',
      worktree: 'same',
    })
    rejects(() => posix['sessions.fork']({ sessionId: 's', worktree: 'other' }))
  })

  it('removes a worktree only against the state the user was shown', () => {
    const expected = {
      exists: true,
      branchExists: true,
      head: 'a'.repeat(40),
      uncommitted: 0,
      unpushed: 0,
      merged: true,
    }
    expect(posix['worktrees.remove']({ sessionId: 's', branch: 'delete', expected })).toEqual({
      sessionId: 's',
      branch: 'delete',
      expected,
    })
    rejects(() => posix['worktrees.remove']({ sessionId: 's', branch: 'force', expected }))
    rejects(() => posix['worktrees.remove']({ sessionId: 's', branch: 'keep' }))
    rejects(() =>
      posix['worktrees.remove']({
        sessionId: 's',
        branch: 'keep',
        expected: { ...expected, uncommitted: -1 },
      }),
    )
    rejects(() =>
      posix['worktrees.remove']({
        sessionId: 's',
        branch: 'keep',
        expected: { ...expected, head: '--all' },
      }),
    )
  })

  it('reads the setup output whole or from an offset', () => {
    expect(posix['worktrees.setupLog']({ sessionId: 's' })).toEqual({ sessionId: 's' })
    expect(posix['worktrees.setupLog']({ sessionId: 's', from: 1200 })).toEqual({
      sessionId: 's',
      from: 1200,
    })
    rejects(() => posix['worktrees.setupLog']({ sessionId: 's', from: -1 }))
    rejects(() => posix['worktrees.setupLog']({ sessionId: 's', from: 1.5 }))
    rejects(() => posix['worktrees.setupLog']({ sessionId: 's', from: '10' }))
  })

  it("checks a project's worktree settings as the host will use them", () => {
    const set = (value: unknown, validators = posix) =>
      validators['projects.setWorktreeSettings']({ path: '/repo', settings: value })
    expect(set(settings)).toEqual({ path: '/repo', settings })
    expect(set({ ...settings, copy: ['./.env', '.env'], setup: null })).toEqual({
      path: '/repo',
      settings: { ...settings, copy: ['.env'], setup: null },
    })
    for (const branchTemplate of ['{user}/{slug}', '-{slug}', '{slug}..x', 'x'.repeat(201)]) {
      rejects(() => set({ ...settings, branchTemplate }))
    }
    for (const entry of [
      '/etc/passwd',
      '../secret',
      'a/../../b',
      '*.env',
      '.git/config',
      '.',
      '',
    ]) {
      rejects(() => set({ ...settings, copy: [entry] }))
    }
    rejects(() => set({ ...settings, copy: ['C:\\secret'] }, windows))
    rejects(() => set({ ...settings, copy: ['a:b'] }, windows))
    rejects(() => set({ ...settings, copy: Array.from({ length: 101 }, (_, i) => `f${i}`) }))
    for (const setup of ['', '   ', 'x'.repeat(8193), 'a\0b', 3]) {
      rejects(() => set({ ...settings, setup }))
    }
    rejects(() => set({ ...settings, waitForSetup: 'yes' }))
    rejects(() => posix['projects.setWorktreeSettings']({ path: 'repo', settings }))
  })

  it("keeps a queued message's comment summary only when it reads", () => {
    const content = [{ type: 'text', text: '> a\n\nb' }]
    const comments = { count: 2, text: 'Looks good' }
    expect(posix['sessions.queue']({ sessionId: 's', content, comments })).toEqual({
      sessionId: 's',
      content,
      comments,
    })
    expect(posix['sessions.queue']({ sessionId: 's', content })).toEqual({
      sessionId: 's',
      content,
    })
    for (const bad of [
      { count: 0, text: 'x' },
      { count: 1.5, text: 'x' },
      { count: 1, text: '' },
      { count: 1, text: 'x'.repeat(501) },
      { count: 1 },
      'two',
    ]) {
      rejects(() => posix['sessions.queue']({ sessionId: 's', content, comments: bad }))
    }
  })

  it("runs only a reply's code block that shows all it runs", () => {
    expect(
      posix['sessions.runCommand']({
        sessionId: 's',
        command: 'sudo true\npnpm dev',
        notify: true,
      }),
    ).toEqual({ sessionId: 's', command: 'sudo true\npnpm dev', notify: true })
    for (const command of ['', ' \n ', 'ls\r', 'ls\x1b[A', 'rm -rf a\u202e', 'cd\u200b/tmp']) {
      rejects(() => posix['sessions.runCommand']({ sessionId: 's', command, notify: false }))
    }
    rejects(() =>
      posix['sessions.runCommand']({
        sessionId: 's',
        command: 'a'.repeat(16 * 1024 + 1),
        notify: false,
      }),
    )
    rejects(() => posix['sessions.runCommand']({ sessionId: 's', command: 'ls' }))
  })
})
