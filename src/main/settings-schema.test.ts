import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type AddedAgent, type SettingsFile } from '@shared/settings'
import type { MarketServer, MarketSkill } from '@shared/marketplace'
import {
  effectiveDirect,
  hostSettings,
  mergeSettings,
  parseSettingsFile,
  reachesHost,
  validateSettingsPatch,
  withAllowedComputerApp,
  withoutAgent,
} from './settings-schema'

function settingsWith(changes: Partial<SettingsFile>): SettingsFile {
  return { ...structuredClone(DEFAULT_SETTINGS), ...changes }
}

describe('turned-off agents in a patch', () => {
  it('accepts a list of known agents', () => {
    const patch = validateSettingsPatch({ disabledAgents: ['codex', 'claude-code~work'] })
    expect(patch.disabledAgents).toEqual(['codex', 'claude-code~work'])
  })

  it('accepts an empty list, which turns every agent on', () => {
    expect(validateSettingsPatch({ disabledAgents: [] }).disabledAgents).toEqual([])
  })

  it.each([
    ['a value that is no list', 'codex'],
    ['an unknown agent', ['no-such-agent']],
    ['an added agent of a harness that takes none', ['opencode~work']],
    ['an agent named twice', ['codex', 'codex']],
    ['an id that is no string', [42]],
  ])('rejects %s', (_, value) => {
    expect(() => validateSettingsPatch({ disabledAgents: value })).toThrow()
  })

  it('replaces the stored list whole', () => {
    const current = settingsWith({ disabledAgents: ['codex', 'claude-code'] })
    const next = mergeSettings(current, { disabledAgents: ['opencode'] })
    expect(next.disabledAgents).toEqual(['opencode'])
    expect(current.disabledAgents).toEqual(['codex', 'claude-code'])
  })

  it('leaves the list alone when the patch does not name it', () => {
    const current = settingsWith({ disabledAgents: ['codex'] })
    expect(mergeSettings(current, { general: { sendKey: 'mod-enter' } }).disabledAgents).toEqual([
      'codex',
    ])
  })
})

describe('turned-off agents in the settings file', () => {
  it('defaults to none for a file from before the list', () => {
    expect(parseSettingsFile({ version: 1 }).settings.disabledAgents).toEqual([])
  })

  it('keeps the known agents and drops unknown and repeated ones', () => {
    const { settings, problems } = parseSettingsFile({
      version: 1,
      disabledAgents: ['codex', 'gone-agent', 'codex', 7, 'claude-code~work'],
    })
    expect(settings.disabledAgents).toEqual(['codex', 'claude-code~work'])
    expect(problems).toEqual([])
  })

  it('reports a list that is no array and turns every agent on', () => {
    const { settings, problems } = parseSettingsFile({ version: 1, disabledAgents: 'codex' })
    expect(settings.disabledAgents).toEqual([])
    expect(problems).toHaveLength(1)
  })
})

describe('removing a turned-off agent', () => {
  const added: AddedAgent = {
    id: 'claude-code~work',
    name: 'Work',
    configDir: '/tmp/work',
    created: false,
  }

  it('forgets an added agent in the list', () => {
    const current = settingsWith({
      addedAgents: [added],
      disabledAgents: ['codex', 'claude-code~work'],
    })
    expect(withoutAgent(current, 'claude-code~work').disabledAgents).toEqual(['codex'])
  })

  it("forgets a harness's default agent in the list", () => {
    const current = settingsWith({
      agents: { codex: { enabled: true } },
      disabledAgents: ['codex', 'opencode'],
    })
    expect(withoutAgent(current, 'codex').disabledAgents).toEqual(['opencode'])
  })
})

describe('computer use settings', () => {
  const app = { id: 'com.apple.textedit', name: 'TextEdit' }

  it('is off with no apps until the user turns it on', () => {
    expect(parseSettingsFile({ version: 1 }).settings.computerUse).toEqual({
      enabled: false,
      allowedApps: [],
    })
  })

  it('accepts the switch and a list of apps, and replaces the list whole', () => {
    const patch = validateSettingsPatch({ computerUse: { enabled: true, allowedApps: [app] } })
    const current = settingsWith({
      computerUse: { enabled: false, allowedApps: [{ id: 'x', name: 'X' }] },
    })
    expect(mergeSettings(current, patch).computerUse).toEqual({ enabled: true, allowedApps: [app] })
  })

  it.each([
    ['a switch that is no boolean', { enabled: 'yes' }],
    ['an app without an id', { allowedApps: [{ id: '', name: 'X' }] }],
    ['an app with more fields', { allowedApps: [{ ...app, path: '/Applications' }] }],
    ['an app named twice', { allowedApps: [app, app] }],
    ['an unknown field', { unrestricted: true }],
  ])('rejects %s', (_, value) => {
    expect(() => validateSettingsPatch({ computerUse: value })).toThrow()
  })

  it('drops an invalid list from the file and keeps the switch', () => {
    const loaded = parseSettingsFile({
      version: 1,
      computerUse: { enabled: true, allowedApps: 'all' },
    })
    expect(loaded.settings.computerUse).toEqual({ enabled: true, allowedApps: [] })
    expect(loaded.problems).toHaveLength(1)
  })

  it('always allows an app once, from the host', () => {
    const once = withAllowedComputerApp(settingsWith({}), app)
    expect(once.computerUse.allowedApps).toEqual([app])
    expect(withAllowedComputerApp(once, app)).toBe(once)
    expect(() => withAllowedComputerApp(once, { id: 7 })).toThrow()
  })
})

describe('remote access and the relay', () => {
  const on = (): SettingsFile =>
    mergeSettings(structuredClone(DEFAULT_SETTINGS), { remote: { enabled: true } })

  it('uses the relay by default, keeping direct connections as the owner set them', () => {
    const settings = on()
    expect(settings.remote.relay).toBe(true)
    expect(settings.remote.direct.enabled).toBe(false)
    expect(settings.general.background).toBe(true)
    expect(parseSettingsFile({ version: 1 }).settings.remote.relay).toBe(true)
  })

  it('holds direct connections on without the relay, stored or while not signed in', () => {
    const settings = on()
    expect(effectiveDirect(settings, true).enabled).toBe(false)
    expect(effectiveDirect(settings, false).enabled).toBe(true)
    const off = mergeSettings(settings, { remote: { relay: false } })
    expect(off.remote.direct.enabled).toBe(true)
    expect(effectiveDirect(off, true).enabled).toBe(true)
    expect(() => validateSettingsPatch({ remote: { relay: 'yes' } })).toThrow()
  })
})

describe('the Marketplace servers', () => {
  const github: MarketServer = {
    id: 'io.github.github/github-mcp-server',
    name: 'github',
    title: 'GitHub',
    source: 'registry',
    version: '1.2.0',
    spec: {
      type: 'http',
      transport: 'streamable-http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: [
        { name: 'X-Client', value: 'kettu' },
        { name: 'Authorization', input: true, secret: true, required: true, description: 'Token' },
      ],
    },
    agents: 'all',
    on: true,
  }
  const local: MarketServer = {
    id: 'manual:0f8fad5b-d9cb-469f-a165-70867728950e',
    name: 'notes_2',
    title: 'Notes',
    source: 'manual',
    version: null,
    spec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@example/notes-mcp', '--dir=/tmp/notes'],
      env: [
        { name: 'NOTES_MODE', value: 'read' },
        { name: 'NOTES_TOKEN', input: true, secret: false, required: false },
      ],
    },
    agents: ['codex', 'claude-code~work'],
    on: false,
  }
  const patchWith = (server: unknown): unknown => ({ marketplace: { mcp: [server] } })
  const changed = (changes: Record<string, unknown>): Record<string, unknown> => ({
    ...structuredClone(github),
    ...changes,
  })
  const withSpec = (changes: Record<string, unknown>): Record<string, unknown> =>
    changed({ spec: { ...structuredClone(github.spec), ...changes } })
  const withEnv = (env: unknown): Record<string, unknown> =>
    changed({ ...structuredClone(local), spec: { ...structuredClone(local.spec), env } })

  it('accepts remote and local servers and replaces the list whole', () => {
    const patch = validateSettingsPatch({ marketplace: { mcp: [github, local] } })
    const first = mergeSettings(structuredClone(DEFAULT_SETTINGS), patch)
    expect(first.marketplace.mcp).toEqual([github, local])
    const second = mergeSettings(first, validateSettingsPatch({ marketplace: { mcp: [local] } }))
    expect(second.marketplace.mcp).toEqual([local])
    expect(first.marketplace.mcp).toHaveLength(2)
  })

  it('keeps the prefix a header input is sent with', () => {
    const header = { name: 'Authorization', input: true, secret: true, required: true }
    const patch = validateSettingsPatch(
      patchWith(withSpec({ headers: [{ ...header, prefix: 'Bearer ' }] })),
    )
    const spec = patch.marketplace?.mcp?.[0]?.spec
    expect(spec?.type === 'http' && spec.headers[0]).toEqual({ ...header, prefix: 'Bearer ' })
  })

  it('keeps how a remote server signs in with OAuth', () => {
    for (const flow of ['browser', 'device'] as const) {
      const patch = validateSettingsPatch(patchWith(withSpec({ oauth: { flow } })))
      const spec = patch.marketplace?.mcp?.[0]?.spec
      expect(spec?.type === 'http' && spec.oauth).toEqual({ flow })
    }
  })

  it.each([
    ['an unknown flow', withSpec({ oauth: { flow: 'password' } })],
    ['an OAuth that is no object', withSpec({ oauth: 'browser' })],
    ['an unknown OAuth key', withSpec({ oauth: { flow: 'browser', clientId: 'x' } })],
    [
      'OAuth on a local server',
      changed({ ...structuredClone(local), spec: { ...local.spec, oauth: { flow: 'browser' } } }),
    ],
  ])('rejects %s', (_, server) => {
    expect(() => validateSettingsPatch(patchWith(server))).toThrow()
  })

  it('reads a stored OAuth, without what a newer version adds to it', () => {
    const stored = withSpec({ oauth: { flow: 'device', scopes: ['repo'] } })
    const { settings, problems } = parseSettingsFile({
      version: 1,
      marketplace: { mcp: [stored] },
    })
    const spec = settings.marketplace.mcp[0]?.spec
    expect(spec?.type === 'http' && spec.oauth).toEqual({ flow: 'device' })
    expect(problems).toEqual([])
  })

  it.each([
    ['a list that is no array', { marketplace: { mcp: github } }],
    ['an unknown key in the section', { marketplace: { mcp: [], other: 1 } }],
    ['an unknown key in a server', patchWith(changed({ token: 'x' }))],
    ['an id that is no registry name', patchWith(changed({ id: 'github' }))],
    ['an id with a line break', patchWith(changed({ id: 'io.github/x\n' }))],
    ['a long id', patchWith(changed({ id: `io.github/${'a'.repeat(200)}` }))],
    ['a manual id without a UUID', patchWith(changed({ source: 'manual', id: 'manual:1' }))],
    ['an unknown source', patchWith(changed({ source: 'store' }))],
    ['a name with capitals', patchWith(changed({ name: 'GitHub' }))],
    ['the name of the built-in server', patchWith(changed({ name: 'kettu' }))],
    ['an empty title', patchWith(changed({ title: '' }))],
    ['a title with a control character', patchWith(changed({ title: 'Git\u0007Hub' }))],
    ['a version that is no string', patchWith(changed({ version: 2 }))],
    ['an unknown agent', patchWith(changed({ agents: ['no-such-agent'] }))],
    ['an agent named twice', patchWith(changed({ agents: ['codex', 'codex'] }))],
    ['agents that are neither all nor a list', patchWith(changed({ agents: 'some' }))],
    ['an on that is no boolean', patchWith(changed({ on: 'yes' }))],
    ['an unknown spec type', patchWith(withSpec({ type: 'ws' }))],
    ['an unknown transport', patchWith(withSpec({ transport: 'websocket' }))],
    ['a URL that is not http', patchWith(withSpec({ url: 'file:///etc/passwd' }))],
    ['a URL that does not parse', patchWith(withSpec({ url: 'not a url' }))],
    ['a header name with a space', patchWith(withSpec({ headers: [{ name: 'X Y', value: 'v' }] }))],
    [
      'an input prefix with a line break',
      patchWith(
        withSpec({
          headers: [
            { name: 'Authorization', input: true, secret: true, required: true, prefix: 'B\r\n' },
          ],
        }),
      ),
    ],
    [
      'a header value with a line break',
      patchWith(withSpec({ headers: [{ name: 'X-A', value: 'v\r\nX-B: w' }] })),
    ],
    [
      'a header named twice',
      patchWith(
        withSpec({
          headers: [
            { name: 'X-A', value: 'v' },
            { name: 'x-a', value: 'w' },
          ],
        }),
      ),
    ],
    [
      'an input that is not true',
      patchWith(
        withSpec({ headers: [{ name: 'X-A', input: 'yes', secret: true, required: true }] }),
      ),
    ],
    [
      'an input without secret',
      patchWith(withSpec({ headers: [{ name: 'X-A', input: true, required: true }] })),
    ],
    [
      'a long input description',
      patchWith(
        withSpec({
          headers: [
            {
              name: 'X-A',
              input: true,
              secret: true,
              required: true,
              description: 'd'.repeat(1001),
            },
          ],
        }),
      ),
    ],
    [
      'an empty command',
      patchWith(changed({ ...structuredClone(local), spec: { ...local.spec, command: ' ' } })),
    ],
    [
      'a command with a line break',
      patchWith(changed({ ...structuredClone(local), spec: { ...local.spec, command: 'a\nb' } })),
    ],
    [
      'an argument with a NUL',
      patchWith(changed({ ...structuredClone(local), spec: { ...local.spec, args: ['a\0'] } })),
    ],
    [
      'an argument that is no string',
      patchWith(changed({ ...structuredClone(local), spec: { ...local.spec, args: [1] } })),
    ],
    ['an environment name with a dash', patchWith(withEnv([{ name: 'MY-VAR', value: 'v' }]))],
    ['an environment name with a digit first', patchWith(withEnv([{ name: '1A', value: 'v' }]))],
    ['a long fixed value', patchWith(withEnv([{ name: 'A', value: 'v'.repeat(4097) }]))],
    ['two servers with one name', { marketplace: { mcp: [github, { ...local, name: 'github' }] } }],
    ['two servers with one id', { marketplace: { mcp: [github, { ...local, id: github.id }] } }],
    [
      'more than 200 servers',
      {
        marketplace: {
          mcp: Array.from({ length: 201 }, (_, index) => ({
            ...github,
            id: `io.github.example/s${index}`,
            name: `s${index}`,
          })),
        },
      },
    ],
  ])('rejects %s', (_, patch) => {
    expect(() => validateSettingsPatch(patch)).toThrow()
  })

  it('reads a file without the section as no servers', () => {
    expect(parseSettingsFile({ version: 1 }).settings.marketplace).toEqual({ mcp: [], skills: [] })
  })

  it('drops invalid and repeated servers from the file and keeps the rest', () => {
    const { settings, problems } = parseSettingsFile({
      version: 1,
      marketplace: {
        mcp: [
          github,
          { ...github, name: 'kettu', id: 'io.github.example/other' },
          { ...local, name: 'github' },
          { ...local, spec: { ...local.spec, command: '' } },
          local,
        ],
      },
    })
    expect(settings.marketplace.mcp).toEqual([github, local])
    expect(problems).toHaveLength(3)
  })

  it('keeps a stored server with fields of a newer version, without them', () => {
    const { settings, problems } = parseSettingsFile({
      version: 1,
      marketplace: { mcp: [{ ...github, oauth: true, agents: ['codex', 'gone-agent'] }] },
    })
    expect(settings.marketplace.mcp).toEqual([{ ...github, agents: ['codex'] }])
    expect(problems).toEqual([])
  })

  it('reaches the agent host', () => {
    const settings = mergeSettings(
      structuredClone(DEFAULT_SETTINGS),
      validateSettingsPatch({ marketplace: { mcp: [github] } }),
    )
    expect(hostSettings(settings, 'en').marketplace.mcp).toEqual([github])
    expect(reachesHost(new Set(['marketplace']))).toBe(true)
  })

  it('takes a removed agent out of the servers given to it', () => {
    const current = settingsWith({
      addedAgents: [
        { id: 'claude-code~work', name: 'Work', configDir: '/tmp/work', created: false },
      ],
      marketplace: { mcp: [github, local], skills: [] },
    })
    const next = withoutAgent(current, 'claude-code~work')
    expect(next.marketplace.mcp).toEqual([github, { ...local, agents: ['codex'] }])
    expect(current.marketplace.mcp[1]?.agents).toEqual(['codex', 'claude-code~work'])
  })
})

describe('the Marketplace skills', () => {
  const pdf: MarketSkill = {
    id: 'anthropics/skills:pdf',
    name: 'pdf',
    description: 'Reads and fills PDF forms.\nUse it for any PDF.',
    source: 'catalog',
    origin: 'https://github.com/anthropics/skills',
    version: '0123456789abcdef0123456789abcdef01234567',
    agents: 'all',
    on: true,
  }
  const review: MarketSkill = {
    id: 'github:octo-org/agent-skills/skills/code-review',
    name: 'code-review',
    description: 'Reviews a diff.',
    source: 'github',
    origin: 'https://github.com/octo-org/agent-skills',
    version: null,
    agents: ['codex', 'claude-code~work'],
    on: false,
  }
  const notes: MarketSkill = {
    id: 'local:0f8fad5b-d9cb-469f-a165-70867728950e',
    name: 'notes',
    description: 'Keeps notes.',
    source: 'local',
    origin: process.platform === 'win32' ? 'C:\\skills\\notes' : '/home/ada/skills/notes',
    version: null,
    agents: ['codex'],
    on: true,
  }
  const patchWith = (skill: unknown): unknown => ({ marketplace: { skills: [skill] } })
  const changed = (changes: Record<string, unknown>): Record<string, unknown> => ({
    ...structuredClone(pdf),
    ...changes,
  })
  const github = (id: string): Record<string, unknown> => ({ ...structuredClone(review), id })

  it('accepts skills from each source and replaces their list apart from the servers', () => {
    const first = mergeSettings(
      structuredClone(DEFAULT_SETTINGS),
      validateSettingsPatch({ marketplace: { skills: [pdf, review, notes] } }),
    )
    expect(first.marketplace.skills).toEqual([pdf, review, notes])
    const second = mergeSettings(first, validateSettingsPatch({ marketplace: { mcp: [] } }))
    expect(second.marketplace.skills).toEqual([pdf, review, notes])
    const third = mergeSettings(second, validateSettingsPatch({ marketplace: { skills: [notes] } }))
    expect(third.marketplace.skills).toEqual([notes])
  })

  it('accepts a GitHub id of a whole repository', () => {
    expect(() => validateSettingsPatch(patchWith(github('github:octo/repo.js')))).not.toThrow()
  })

  it.each([
    ['a list that is no array', { marketplace: { skills: pdf } }],
    ['an unknown key in a skill', patchWith(changed({ path: 'pdf' }))],
    ['an unknown source', patchWith(changed({ source: 'store' }))],
    ['a catalog id of another repository', patchWith(changed({ id: 'other/skills:pdf' }))],
    ['a catalog id with no name', patchWith(changed({ id: 'anthropics/skills:' }))],
    ['a GitHub id without a repository', patchWith(github('github:octo-org'))],
    ['a GitHub id with a bad owner', patchWith(github('github:-octo/repo'))],
    ['a GitHub id that climbs out', patchWith(github('github:octo/repo/skills/../../etc'))],
    ['a GitHub id with a dot folder', patchWith(github('github:octo/repo/./x'))],
    ['a GitHub id with an empty folder', patchWith(github('github:octo/repo//x'))],
    ['a GitHub id with a backslash', patchWith(github('github:octo/repo/a\\b'))],
    ['a GitHub id with a line break', patchWith(github('github:octo/repo/a\nb'))],
    ['a long GitHub id', patchWith(github(`github:octo/repo/${'a/'.repeat(260)}x`))],
    ['a local id without a UUID', patchWith({ ...notes, id: 'local:notes' })],
    ['a local id with capitals', patchWith({ ...notes, id: notes.id.toUpperCase() })],
    ['an id that does not match its source', patchWith({ ...notes, source: 'catalog' })],
    ['a name with capitals', patchWith(changed({ name: 'PDF' }))],
    ['a name ending in a dash', patchWith(changed({ name: 'pdf-' }))],
    ['a name of 65 characters', patchWith(changed({ name: 'a'.repeat(65) }))],
    ['an empty description', patchWith(changed({ description: '' }))],
    ['a long description', patchWith(changed({ description: 'd'.repeat(1025) }))],
    ['a description with a NUL', patchWith(changed({ description: 'a\0b' }))],
    ['an origin that is not https', patchWith(changed({ origin: 'http://github.com/x/y' }))],
    ['an origin that is no URL', patchWith(changed({ origin: 'github.com/x/y' }))],
    ['a local origin that is relative', patchWith({ ...notes, origin: 'skills/notes' })],
    ['a local origin with a NUL', patchWith({ ...notes, origin: `${notes.origin}\0` })],
    ['a version that is no string', patchWith(changed({ version: 1 }))],
    ['an unknown agent', patchWith(changed({ agents: ['no-such-agent'] }))],
    ['an on that is no boolean', patchWith(changed({ on: 1 }))],
    ['two skills with one name', { marketplace: { skills: [pdf, { ...notes, name: 'pdf' }] } }],
    ['two skills with one id', { marketplace: { skills: [notes, { ...notes, name: 'other' }] } }],
    [
      'more than 500 skills',
      {
        marketplace: {
          skills: Array.from({ length: 501 }, (_, index) => ({
            ...pdf,
            id: `anthropics/skills:s${index}`,
            name: `s${index}`,
          })),
        },
      },
    ],
  ])('rejects %s', (_, patch) => {
    expect(() => validateSettingsPatch(patch)).toThrow()
  })

  it('reads a file from before skills as none', () => {
    const { settings, problems } = parseSettingsFile({ version: 1, marketplace: { mcp: [] } })
    expect(settings.marketplace).toEqual({ mcp: [], skills: [] })
    expect(problems).toEqual([])
  })

  it('drops invalid and repeated skills from the file and keeps the rest', () => {
    const { settings, problems } = parseSettingsFile({
      version: 1,
      marketplace: {
        skills: [pdf, { ...review, name: 'pdf' }, { ...notes, origin: 'notes' }, notes],
      },
    })
    expect(settings.marketplace.skills).toEqual([pdf, notes])
    expect(problems).toHaveLength(2)
  })

  it('reaches the agent host', () => {
    const settings = mergeSettings(
      structuredClone(DEFAULT_SETTINGS),
      validateSettingsPatch({ marketplace: { skills: [pdf] } }),
    )
    expect(hostSettings(settings, 'en').marketplace.skills).toEqual([pdf])
  })

  it('takes a removed agent out of the skills given to it', () => {
    const current = settingsWith({
      addedAgents: [
        { id: 'claude-code~work', name: 'Work', configDir: '/tmp/work', created: false },
      ],
      marketplace: { mcp: [], skills: [pdf, review] },
    })
    const next = withoutAgent(current, 'claude-code~work')
    expect(next.marketplace.skills).toEqual([pdf, { ...review, agents: ['codex'] }])
  })
})
