import { describe, expect, it } from 'vitest'
import { parseManifest } from './manifest'

const SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
const manifest = (fields: Record<string, unknown>): string =>
  JSON.stringify({ $schema: SCHEMA, name: 'review-kit', ...fields })
const kettu = (entry: Record<string, unknown>): string =>
  manifest({ extensions: { 'sh.kettu': { format: 1, ...entry } } })
const read = (text: string) => parseManifest(text, '0.3.0')

describe('plugin.json', () => {
  it('reads a minimal manifest, without an entry of Kettu', () => {
    expect(read(manifest({}))).toMatchObject({
      spec: '1.0.0',
      name: 'review-kit',
      version: null,
      kettu: null,
      warnings: [],
    })
  })

  it('reports an unknown top-level field and ignores it', () => {
    const parsed = read(manifest({ version: '1.2.0', hooks: { run: 'rm -rf /' } }))
    expect(parsed.version).toBe('1.2.0')
    expect(parsed.warnings).toHaveLength(1)
    expect(parsed.warnings[0]).toContain('hooks')
  })

  it('reports extensions that are not an object and goes on', () => {
    expect(read(manifest({ extensions: [] })).warnings).toHaveLength(1)
  })

  it('never reads another client namespace', () => {
    expect(read(manifest({ extensions: { 'com.example': { format: 'x' } } })).kettu).toBeNull()
  })

  it.each([
    ['text that is not JSON', '{'],
    ['an array', '[]'],
    ['no $schema', JSON.stringify({ name: 'a' })],
    ['a format version Kettu does not read', JSON.stringify({ $schema: 'x', name: 'a' })],
    ['no name', JSON.stringify({ $schema: SCHEMA })],
    ['an uppercase name', manifest({ name: 'Review' })],
    ['a name with two hyphens in a row', manifest({ name: 'a--b' })],
    ['a version that is not a string', manifest({ version: 1 })],
    ['an author with an unknown field', manifest({ author: { name: 'B', twitter: 'b' } })],
    ['keywords that are not strings', manifest({ keywords: [1] })],
    ['an entry of Kettu that is not an object', manifest({ extensions: { 'sh.kettu': 1 } })],
  ])('refuses %s', (_, text) => {
    expect(() => read(text)).toThrowError(expect.objectContaining({ code: 'invalid_params' }))
  })

  it('reads the 1.1.0 display name, which 1.0.0 does not have', () => {
    const next = SCHEMA.replace('1.0.0', '1.1.0')
    expect(read(manifest({ $schema: next, displayName: 'Review kit' })).displayName).toBe(
      'Review kit',
    )
    const old = read(manifest({ displayName: 'Review kit' }))
    expect(old.displayName).toBeNull()
    expect(old.warnings).toHaveLength(1)
  })
})

describe('the sh.kettu entry', () => {
  it('reads the format, versions, texts, settings, script and permissions', () => {
    const parsed = read(
      kettu({
        kettu: '>=0.2.0',
        title: { en: 'Review kit', 'zh-CN': 'Review kit' },
        description: 'Reviews.',
        settings: [
          { key: 'strict', type: 'boolean', title: 'Strict', default: true },
          {
            key: 'tone',
            type: 'select',
            title: 'Tone',
            options: [{ value: 'kind', title: 'Kind' }],
          },
        ],
        views: [{ id: 'issues', kind: 'list', title: 'Issues', icon: 'bug' }],
        script: './sh.kettu/main.js',
        api: 1,
        permissions: ['network:api.example.com', 'tools', 'tools'],
      }),
    )
    expect(parsed.kettu).toMatchObject({
      kettu: '>=0.2.0',
      titles: { en: 'Review kit' },
      descriptions: { en: 'Reviews.' },
      script: 'sh.kettu/main.js',
      api: 1,
      permissions: ['network:api.example.com', 'tools'],
    })
    expect(parsed.kettu?.settings).toHaveLength(2)
    expect(parsed.kettu?.views).toEqual([
      { id: 'issues', kind: 'list', title: { en: 'Issues' }, icon: 'bug' },
    ])
  })

  it('reads views of every kind, with titles by language', () => {
    const parsed = read(
      kettu({
        script: './main.js',
        api: 1,
        views: ['list', 'detail', 'form', 'actions'].map((kind) => ({
          id: `my-${kind}`,
          kind,
          title: { en: 'A', 'zh-CN': '甲' },
          description: 'About it',
        })),
      }),
    )
    expect(parsed.kettu?.views.map((view) => view.kind)).toEqual([
      'list',
      'detail',
      'form',
      'actions',
    ])
    expect(parsed.kettu?.views[0]).toMatchObject({
      title: { en: 'A', 'zh-CN': '甲' },
      description: { en: 'About it' },
    })
  })

  it('passes over a view field and an icon a later Kettu may add, with a warning', () => {
    const parsed = read(
      kettu({
        script: './main.js',
        api: 1,
        views: [{ id: 'a', kind: 'list', title: 'A', icon: 'unicorn', badge: 'new' }],
      }),
    )
    expect(parsed.kettu?.views).toEqual([{ id: 'a', kind: 'list', title: { en: 'A' } }])
    expect(parsed.warnings).toHaveLength(2)
  })

  it('reads the events that wake the script, only those whose permission it asks for', () => {
    const parsed = read(
      kettu({
        permissions: ['sessions.summary', 'requests.check'],
        events: [
          'session.turnEnded',
          'session.turnEnded',
          'session.permissionRequested',
          'session.beforeSend',
          'session.fromTheFuture',
        ],
      }),
    )
    expect(parsed.kettu?.events).toEqual(['session.turnEnded', 'session.permissionRequested'])
    expect(parsed.warnings).toHaveLength(2)
    expect(parsed.warnings[0]).toContain('prompt.attach')
    expect(parsed.warnings[1]).toContain('session.fromTheFuture')
  })

  describe('tools', () => {
    const script = { script: './main.js', api: 1, permissions: ['tools'] }
    const lookup = {
      name: 'lookup',
      description: 'Looks a word up.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', enum: ['a', 'b'] },
          n: { type: 'integer', minimum: 1 },
        },
        required: ['query'],
      },
    }

    it('are read with the arguments each takes, closed to any other', () => {
      const parsed = read(kettu({ ...script, tools: [lookup] }))
      expect(parsed.kettu?.tools).toEqual([
        {
          name: 'lookup',
          description: 'Looks a word up.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', enum: ['a', 'b'] },
              n: { type: 'integer', minimum: 1 },
            },
            required: ['query'],
            additionalProperties: false,
          },
        },
      ])
    })

    it('are left out, and said so, without the permission', () => {
      const parsed = read(kettu({ script: './main.js', api: 1, tools: [lookup] }))
      expect(parsed.kettu?.tools).toEqual([])
      expect(parsed.warnings).toHaveLength(1)
      expect(parsed.warnings[0]).toContain('tools')
    })

    it.each([
      ['without a script', { permissions: ['tools'], tools: [lookup] }],
      ['with a name that is not a name', { ...script, tools: [{ ...lookup, name: 'Look-up' }] }],
      ['named twice', { ...script, tools: [lookup, lookup] }],
      ['with no description', { ...script, tools: [{ ...lookup, description: ' ' }] }],
      [
        'with an argument of a type it does not take',
        {
          ...script,
          tools: [
            { ...lookup, inputSchema: { type: 'object', properties: { a: { type: 'array' } } } },
          ],
        },
      ],
      [
        'that allows other arguments',
        {
          ...script,
          tools: [{ ...lookup, inputSchema: { type: 'object', additionalProperties: true } }],
        },
      ],
      [
        'that requires an argument it does not have',
        { ...script, tools: [{ ...lookup, inputSchema: { type: 'object', required: ['x'] } }] },
      ],
      [
        'more than sixteen',
        { ...script, tools: Array.from({ length: 17 }, (_, i) => ({ ...lookup, name: `t${i}` })) },
      ],
    ])('are refused %s', (_, entry) => {
      expect(() => read(kettu(entry))).toThrowError(
        expect.objectContaining({ code: 'invalid_params' }),
      )
    })
  })

  it('refuses events that are not a list of names', () => {
    expect(() => read(kettu({ events: 'session.turnEnded' }))).toThrowError(
      expect.objectContaining({ code: 'invalid_params' }),
    )
    expect(() => read(kettu({ events: [1] }))).toThrowError(
      expect.objectContaining({ code: 'invalid_params' }),
    )
  })

  it('passes over a field a later version of the format added', () => {
    const parsed = read(kettu({ bots: [] }))
    expect(parsed.kettu).not.toBeNull()
    expect(parsed.warnings[0]).toContain('bots')
  })

  it('refuses a format version it does not read, saying which', () => {
    expect(() => read(manifest({ extensions: { 'sh.kettu': { format: 2 } } }))).toThrowError(
      /version 2/,
    )
  })

  it('refuses a package for another Kettu version, saying both', () => {
    expect(() => read(kettu({ kettu: '>=9.0.0' }))).toThrowError(/>=9\.0\.0.*0\.3\.0/)
  })

  it.each([
    ['no format', manifest({ extensions: { 'sh.kettu': {} } })],
    ['a range that is not semver', kettu({ kettu: 'soon' })],
    ['a permission outside the list', kettu({ permissions: ['files.read'] })],
    ['a network permission without a domain', kettu({ permissions: ['network:*'] })],
    ['a network permission for an address', kettu({ permissions: ['network:http://a.b/c'] })],
    ['a script outside the package', kettu({ script: './../main.js', api: 1 })],
    ['a script by an absolute path', kettu({ script: '/tmp/main.js', api: 1 })],
    ['a script without a plugin API version', kettu({ script: './main.js' })],
    ['a plugin API version it does not have', kettu({ script: './main.js', api: 7 })],
    ['a setting without a title', kettu({ settings: [{ key: 'a', type: 'string' }] })],
    [
      'two settings with one key',
      kettu({ settings: [1, 2].map(() => ({ key: 'a', type: 'string', title: 'A' })) }),
    ],
    [
      'a secret with a default',
      kettu({ settings: [{ key: 'a', type: 'secret', title: 'A', default: 'x' }] }),
    ],
    ['views that are not objects', kettu({ script: './m.js', api: 1, views: ['panel'] })],
    [
      'a view of a kind it does not draw',
      kettu({ script: './m.js', api: 1, views: [{ id: 'a', kind: 'panel', title: 'A' }] }),
    ],
    [
      'a view without a title',
      kettu({ script: './m.js', api: 1, views: [{ id: 'a', kind: 'list' }] }),
    ],
    [
      'a view whose id is not an id',
      kettu({ script: './m.js', api: 1, views: [{ id: 'A b', kind: 'list', title: 'A' }] }),
    ],
    [
      'two views with one id',
      kettu({
        script: './m.js',
        api: 1,
        views: [1, 2].map(() => ({ id: 'a', kind: 'list', title: 'A' })),
      }),
    ],
    [
      'views without a script to give them data',
      kettu({ views: [{ id: 'a', kind: 'list', title: 'A' }] }),
    ],
  ])('refuses %s', (_, text) => {
    expect(() => read(text)).toThrowError(expect.objectContaining({ code: 'invalid_params' }))
  })
})
