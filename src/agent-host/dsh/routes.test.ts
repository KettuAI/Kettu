// The model routes Kettu reads from a DeepSeek Harness home: which files, in which order, and
// what of them reaches the session's process.

import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { mergeRoutes, readRoutes } from './routes'

const GATEWAY = `- id: llm-pi-ai
  config:
    providers:
      my-gateway:
        displayName: My Gateway
        apiKeyEnv: GATEWAY_API_KEY
        api: openai-completions
        baseURL: !!js process.env.GATEWAY_URL
        reasoning: high
        models:
          - id: gw-alpha
            name: Gateway Alpha
            reasoningEfforts:
              off:
              high: high
          - id: gw-beta
- id: agent-default-model
  config:
    provider: my-gateway
    model: gw-alpha
`

describe('dsh routes', () => {
  it('lists a configured route with its models and the levels each declares', () => {
    const routes = mergeRoutes([GATEWAY])
    expect(routes.groups).toEqual([
      {
        provider: 'my-gateway',
        name: 'My Gateway',
        effort: 'high',
        models: [
          { id: 'gw-alpha', name: 'Gateway Alpha', efforts: ['off', 'high'] },
          { id: 'gw-beta', name: 'gw-beta', efforts: [] },
        ],
      },
    ])
    expect(routes.selection).toEqual({ provider: 'my-gateway', model: 'gw-alpha', effort: null })
    expect(routes.deepseek).toBeNull()
  })

  it('hands dsh the rows as written, an expression still an expression', () => {
    const { yaml } = mergeRoutes([GATEWAY])
    expect(yaml).toContain('baseURL: !!js process.env.GATEWAY_URL')
    expect(yaml.split('\n').filter((line) => line.startsWith('- '))).toEqual([
      '- id: llm-pi-ai',
      '- id: agent-default-model',
    ])
  })

  it('joins the routes of several files, a later file replacing a route of the same name', () => {
    const older = `- id: llm-pi-ai
  config:
    providers:
      my-gateway:
        api: openai-completions
        baseURL: https://old.example/v1
        models:
          - id: old-model
      other:
        api: anthropic-messages
        baseURL: https://other.example
        models:
          - id: other-model
`
    const routes = mergeRoutes([older, GATEWAY])
    expect(routes.groups.map((group) => [group.provider, group.models.map((m) => m.id)])).toEqual([
      ['my-gateway', ['gw-alpha', 'gw-beta']],
      ['other', ['other-model']],
    ])
    expect(routes.yaml).not.toContain('old.example')
    expect(routes.yaml).toContain('other.example')
  })

  it('keeps a route without a model list for dsh, and lists nothing for it', () => {
    const routes = mergeRoutes([
      `- id: llm-pi-ai
  config:
    providers:
      anthropic:
        apiKeyEnv: ANTHROPIC_API_KEY
`,
    ])
    expect(routes.groups).toEqual([])
    expect(routes.yaml).toContain('anthropic:')
  })

  it('reads the catalog a file gives DeepSeek’s own route', () => {
    const routes = mergeRoutes([
      `- id: llm-deepseek
  config:
    baseURL: https://gateway.example
    reasoningEffort: max
    models:
      - id: my-deepseek
        name: Mine
      - id: plain
        reasoningEfforts: false
`,
    ])
    expect(routes.deepseek).toEqual({
      effort: 'max',
      models: [
        { id: 'my-deepseek', name: 'Mine', efforts: null },
        { id: 'plain', name: 'plain', efforts: [] },
      ],
    })
    expect(routes.yaml).toContain('baseURL: https://gateway.example')
  })

  it('skips a file it cannot read as a list of rows, and rows that configure no model', () => {
    const routes = mergeRoutes([
      'providers: [unclosed',
      'just: a map',
      `- id: ui-settings
  config:
    theme: dark
- insert:
    - id: llm-pi-ai
      name: not-a-row
- id: llm-pi-ai
  disabled: true
`,
    ])
    expect(routes).toEqual({ yaml: '', groups: [], deepseek: null, selection: null })
  })

  it('writes nothing for a home that configures no model', () => {
    expect(mergeRoutes([]).yaml).toBe('')
  })
})

describe('dsh route files', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'kettu-dsh-routes-'))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  const route = (url: string): string => `- id: llm-pi-ai
  config:
    providers:
      shared:
        api: openai-completions
        baseURL: ${url}
        models:
          - id: m
`

  async function profile(name: string, text: string, modified: number): Promise<void> {
    const folder = path.join(home, 'profiles', name)
    await mkdir(folder, { recursive: true })
    const file = path.join(folder, 'cordis.patch.yml')
    await writeFile(file, text)
    await utimes(file, modified, modified)
  }

  const baseURL = async (): Promise<unknown> => {
    const rows = parse((await readRoutes(home)).yaml) as {
      config: { providers: { shared: { baseURL: string } } }
    }[]
    return rows[0]?.config.providers.shared.baseURL
  }

  it('reads the profile dsh’s own pages write, which the sdk profile never composes', async () => {
    await profile('web', GATEWAY, 1_000)
    expect((await readRoutes(home)).groups.map((group) => group.provider)).toEqual(['my-gateway'])
  })

  it('takes the profile changed last, then the sdk profile, then the home’s own file', async () => {
    await profile('web', route('https://web.example'), 2_000)
    await profile('desktop', route('https://desktop.example'), 3_000)
    expect(await baseURL()).toBe('https://desktop.example')
    await profile('sdk', route('https://sdk.example'), 1_000)
    expect(await baseURL()).toBe('https://sdk.example')
    await writeFile(path.join(home, 'cordis.patch.yml'), route('https://home.example'))
    expect(await baseURL()).toBe('https://home.example')
  })

  it('reads nothing from a home that does not exist yet', async () => {
    expect(await readRoutes(path.join(home, 'missing'))).toEqual({
      yaml: '',
      groups: [],
      deepseek: null,
      selection: null,
    })
  })
})
