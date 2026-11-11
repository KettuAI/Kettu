import { describe, expect, it } from 'vitest'
import { HOST_METHODS } from '@shared/agent-host'
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

  it('checks the plugin methods: ids that cannot pass for a flag, and a project for its scopes', () => {
    const plugin = { agentId: 'claude-code', pluginId: 'commit-commands@claude-plugins-official' }
    expect(posix['market.plugins']({ refresh: true })).toEqual({ refresh: true })
    expect(posix['market.pluginDetails']({ ...plugin, other: 1 })).toEqual(plugin)
    rejects(() => posix['market.pluginDetails']({ ...plugin, pluginId: '--yes@x' }))
    rejects(() => posix['market.pluginDetails']({ ...plugin, pluginId: 'no-marketplace' }))
    rejects(() => posix['market.pluginDetails']({ ...plugin, pluginId: 'a@b c' }))
    expect(posix['market.pluginLogo']({ pluginId: 'pdf@openai-primary-runtime', x: 1 })).toEqual({
      pluginId: 'pdf@openai-primary-runtime',
    })
    rejects(() => posix['market.pluginLogo']({ pluginId: '../../.ssh/id_rsa' }))
    expect(posix['market.installPlugin']({ ...plugin, scope: 'user' })).toEqual({
      ...plugin,
      scope: 'user',
    })
    expect(
      posix['market.uninstallPlugin']({ ...plugin, scope: 'project', projectPath: '/repo' }),
    ).toEqual({ ...plugin, scope: 'project', projectPath: '/repo' })
    rejects(() => posix['market.installPlugin']({ ...plugin, scope: 'local' }))
    rejects(() => posix['market.installPlugin']({ ...plugin, scope: 'user', projectPath: '/repo' }))
    rejects(() =>
      posix['market.installPlugin']({ ...plugin, scope: 'project', projectPath: 'repo' }),
    )
    rejects(() => posix['market.installPlugin']({ ...plugin, scope: 'global' }))
    expect(posix['market.setPluginEnabled']({ ...plugin, scope: 'user', enabled: false })).toEqual({
      ...plugin,
      scope: 'user',
      enabled: false,
    })
    rejects(() => posix['market.setPluginEnabled']({ ...plugin, scope: 'user' }))
    expect(posix['market.addMarketplace']({ agentId: 'codex', source: ' owner/repo ' })).toEqual({
      agentId: 'codex',
      source: 'owner/repo',
    })
    rejects(() => posix['market.addMarketplace']({ agentId: 'codex', source: '--scope=user' }))
    rejects(() => posix['market.addMarketplace']({ agentId: 'codex', source: 'a\nb' }))
    expect(posix['market.removeMarketplace']({ agentId: 'codex', name: 'team-tools' })).toEqual({
      agentId: 'codex',
      name: 'team-tools',
    })
    rejects(() => posix['market.removeMarketplace']({ agentId: 'codex', name: '-rf' }))
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
    rejects(() => add({ kind: 'catalog', id: 'anthropics/skills:../x' }))
    rejects(() => add({ kind: 'github', url: 'https://example.com/a/b' }))
    rejects(() => add({ kind: 'local', path: 'relative/skill' }))
    rejects(() => add({ kind: 'npm', id: 'x' }))
    rejects(() => add('anthropics/skills:pdf'))
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
    expect(posix['attachments.read']({ id: 'a1', more: 1 })).toEqual({ id: 'a1' })
    rejects(() => posix['attachments.remove']({}))
    expect(posix['attachments.held']({ ids: ['a1', 'a2'] })).toEqual({ ids: ['a1', 'a2'] })
    rejects(() => posix['attachments.held']({ ids: 'a1' }))
    rejects(() => posix['attachments.held']({ ids: ['a1', ''] }))
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
