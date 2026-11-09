import { describe, expect, it } from 'vitest'
import type { PluginListResponse, PluginSummary, SkillsListResponse } from '../codex/protocol'
import { codexOwnSkills, codexPlugins, setCodexPluginEnabled } from './codex-plugins'

function plugin(id: string, extra: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id,
    name: id.split('@')[0]!,
    version: '1.0.0',
    localVersion: null,
    source: { type: 'local' },
    installed: false,
    enabled: false,
    installPolicy: 'AVAILABLE',
    availability: 'AVAILABLE',
    interface: {
      displayName: 'Linear',
      shortDescription: 'Issues and projects',
      developerName: 'Linear',
      category: 'Productivity',
      websiteUrl: 'https://linear.app',
    },
    ...extra,
  }
}

const LIST: PluginListResponse = {
  marketplaces: [
    {
      name: 'openai-curated',
      path: '/home/.codex/.tmp/plugins/.agents/plugins/marketplace.json',
      interface: { displayName: 'OpenAI Curated' },
      plugins: [
        plugin('linear@openai-curated', { installed: true, enabled: true, localVersion: '1.2.0' }),
        plugin('admin-only@openai-curated', { availability: 'DISABLED_BY_ADMIN' }),
        plugin('remote@openai-curated', { source: { type: 'remote' } }),
      ],
    },
    {
      name: 'team-tools',
      path: '/home/team/.agents/plugins/marketplace.json',
      interface: null,
      plugins: [plugin('deploy@team-tools', { interface: null })],
    },
    { name: 'chatgpt-apps', path: null, interface: null, plugins: [plugin('app@chatgpt-apps')] },
  ],
  marketplaceLoadErrors: [],
  featuredPluginIds: ['linear@openai-curated'],
}

describe("Codex's plugins", () => {
  it('maps plugin/list, leaving out the remote catalog and what cannot be installed', () => {
    const list = codexPlugins(LIST, 'codex')
    expect(list.catalog.map((item) => item.id)).toEqual([
      'linear@openai-curated',
      'deploy@team-tools',
    ])
    expect(list.catalog[0]).toEqual({
      id: 'linear@openai-curated',
      harness: 'codex',
      name: 'linear',
      title: 'Linear',
      description: 'Issues and projects',
      publisher: 'Linear',
      official: true,
      marketplace: 'openai-curated',
      category: 'Productivity',
      homepage: 'https://linear.app/',
      installs: null,
      version: '1.2.0',
      featured: true,
    })
    expect(list.catalog[1]).toMatchObject({ title: 'Deploy', official: false, featured: false })
    expect(list.installed).toEqual([
      {
        id: 'linear@openai-curated',
        harness: 'codex',
        agentId: 'codex',
        version: '1.2.0',
        scope: 'user',
        enabled: true,
        projectPath: null,
      },
    ])
    expect(list.marketplaces.map((item) => [item.name, item.official])).toEqual([
      ['openai-curated', true],
      ['team-tools', false],
    ])
    expect(list.paths['deploy@team-tools']).toBe('/home/team/.agents/plugins/marketplace.json')
  })

  it("switches a plugin in Codex's config as plugins.<id>.enabled", async () => {
    const calls: [string, unknown][] = []
    await setCodexPluginEnabled(
      async <T>(method: string, params?: unknown) => {
        calls.push([method, params])
        return {} as T
      },
      'linear@openai-curated',
      false,
    )
    expect(calls).toEqual([
      [
        'config/value/write',
        {
          keyPath: 'plugins',
          value: { 'linear@openai-curated': { enabled: false } },
          mergeStrategy: 'upsert',
        },
      ],
    ])
  })

  it("lists Codex's own skills without its built-in ones or Kettu's", () => {
    const response: SkillsListResponse = {
      data: [
        {
          cwd: '/home',
          skills: [
            {
              name: 'mine',
              description: 'd',
              path: '/home/.codex/skills/mine/SKILL.md',
              enabled: true,
              scope: 'user',
            },
            {
              name: 'sys',
              description: 'd',
              path: '/codex/system/SKILL.md',
              enabled: true,
              scope: 'system',
            },
            {
              name: 'pdf',
              description: 'd',
              path: '/kettu/skills/pdf/SKILL.md',
              enabled: true,
              scope: 'user',
            },
            {
              name: 'review',
              description: 'Long',
              shortDescription: 'Short',
              path: '/home/.codex/plugins/x/SKILL.md',
              enabled: false,
              scope: 'user',
              pluginId: 'x@openai-curated',
            },
          ],
        },
      ],
    }
    expect(codexOwnSkills(response, 'codex', (file) => file.startsWith('/kettu/'))).toEqual([
      {
        agentId: 'codex',
        name: 'mine',
        description: 'd',
        path: '/home/.codex/skills/mine/SKILL.md',
        enabled: true,
        plugin: null,
      },
      {
        agentId: 'codex',
        name: 'review',
        description: 'Short',
        path: '/home/.codex/plugins/x/SKILL.md',
        enabled: false,
        plugin: 'x@openai-curated',
      },
    ])
  })
})
