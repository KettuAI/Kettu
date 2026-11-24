import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MarketSkill } from '@shared/marketplace'
import type { AgentId } from '@shared/thread'
import type { GuideFlags } from '../guide/guide'
import { COMMIT, tarball } from '../testing/tarball'
import type { SkillRepositorySpec } from './skill-catalog'
import { MarketSkillsService, skillsCatalogFile } from './skills'

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'kettu-skills-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const log = () => {}

const REPOSITORIES: SkillRepositorySpec[] = [
  {
    owner: 'acme',
    repo: 'skills',
    branch: 'main',
    publisher: 'Acme',
    trust: 'verified',
    read: ['skills'],
  },
  { owner: 'bea', repo: 'kit', branch: 'main', publisher: 'Bea', trust: 'community', read: [''] },
]

const skillMd = (name: string, more = '') =>
  `---\nname: ${name}\ndescription: Does ${name}.\n${more}---\n`

/** GitHub as the catalog reads it: the API refuses, as when rate limited; tarballs or a status. */
function github(repos: Record<string, Buffer | number>): typeof fetch {
  return (input) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith('https://api.github.com/')) {
      return Promise.resolve(new Response(null, { status: 403 }))
    }
    const repo = /^https:\/\/codeload\.github\.com\/([^/]+\/[^/]+)\/tar\.gz\//.exec(url)?.[1]
    const body = repo === undefined ? 404 : (repos[repo] ?? 404)
    if (typeof body === 'number') return Promise.resolve(new Response(null, { status: body }))
    return Promise.resolve(new Response(new Uint8Array(body)))
  }
}

function service(fetcher: typeof fetch, kept: readonly MarketSkill[] = []) {
  return new MarketSkillsService({
    userDataPath: root,
    file: skillsCatalogFile(root, log),
    log,
    platform: 'darwin',
    home: root,
    settings: () => kept,
    agents: () => [],
    configFolder: () => null,
    codexSkills: () => Promise.resolve(null),
    kettu: () => Promise.reject(new Error('not in this test')),
    repositories: REPOSITORIES,
    fetch: fetcher,
  })
}

const acme = () =>
  gzipSync(
    tarball([
      {
        name: 'skills-main/skills/pdf/SKILL.md',
        data: skillMd('pdf', 'allowed-tools: Read Bash(python *)\n'),
      },
      { name: 'skills-main/skills/pdf/LICENSE.txt', data: 'MIT License\n' },
    ]),
  )

describe('the skills catalog file', () => {
  it('keeps each repository’s copy, read again from disk after a restart, a failed one aside', async () => {
    const first = service(github({ 'acme/skills': acme(), 'bea/kit': 500 }))
    const read = await first.skills()
    expect(read.catalog).toEqual([
      {
        id: 'acme/skills:pdf',
        name: 'pdf',
        description: 'Does pdf.',
        publisher: 'Acme',
        official: false,
        trust: 'verified',
        repository: 'https://github.com/acme/skills',
        path: 'skills/pdf',
        version: COMMIT,
        license: 'MIT',
        allowedTools: ['Read', 'Bash(python *)'],
      },
    ])
    expect(read.repositories?.map((r) => [r.id, r.read, r.error])).toEqual([
      ['acme/skills', true, null],
      ['bea/kit', false, 'GitHub answered 500'],
    ])
    await first.flush()

    const again = service(() => Promise.reject(new Error('offline')))
    const cached = await again.skills(false, true)
    expect(cached.catalog.map((skill) => skill.id)).toEqual(['acme/skills:pdf'])
    expect(cached.repositories?.map((r) => [r.id, r.read, r.stale ?? false])).toEqual([
      ['acme/skills', true, false],
      ['bea/kit', false, false],
    ])
    expect(cached.stale).toBe(true)
  })

  it('takes the single-repository file of before as Anthropic’s copy, to be read again', async () => {
    await mkdir(path.join(root, 'state'), { recursive: true })
    await writeFile(
      path.join(root, 'state', 'market-skills.json'),
      JSON.stringify({
        version: 1,
        fetchedAt: 1,
        commit: COMMIT,
        dir: COMMIT,
        skills: [{ name: 'pdf', description: 'Reads PDFs.' }, { name: 'Bad Name' }],
      }),
    )
    expect(await skillsCatalogFile(root, log).load()).toEqual({
      version: 2,
      repositories: {
        'anthropics/skills': {
          fetchedAt: null,
          commit: null,
          etag: null,
          dir: COMMIT,
          skills: [
            {
              name: 'pdf',
              description: 'Reads PDFs.',
              path: 'skills/pdf',
              license: null,
              allowedTools: [],
            },
          ],
        },
      },
    })
  })

  it('refuses a file whose repositories name no repository', async () => {
    await mkdir(path.join(root, 'state'), { recursive: true })
    const file = path.join(root, 'state', 'market-skills.json')
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        repositories: {
          '../etc': { fetchedAt: null, commit: null, etag: null, dir: null, skills: [] },
        },
      }),
    )
    expect(await skillsCatalogFile(root, log).load()).toEqual({ version: 2, repositories: {} })
  })
})

describe('adding a skill', () => {
  const kept: MarketSkill = {
    id: 'anthropics/skills:pdf',
    name: 'pdf',
    description: 'Reads PDFs.',
    source: 'catalog',
    origin: 'https://github.com/anthropics/skills',
    version: COMMIT,
    agents: 'all',
    on: true,
  }

  it('refuses a name another kept skill has, naming it, and writes nothing', async () => {
    const skills = service(github({ 'acme/skills': acme(), 'bea/kit': 404 }), [kept])
    await expect(skills.add({ kind: 'catalog', id: 'acme/skills:pdf' })).rejects.toThrow(
      /pdf.*https:\/\/github\.com\/anthropics\/skills/,
    )
    const folder = path.join(root, 'own-pdf')
    await mkdir(folder)
    await writeFile(path.join(folder, 'SKILL.md'), skillMd('pdf'))
    await expect(skills.add({ kind: 'local', path: folder })).rejects.toMatchObject({
      code: 'conflict',
    })
    const store = await readdir(path.join(root, 'marketplace', 'skills')).catch(() => [])
    expect(store).toEqual([])
  })

  it('takes the same skill again by its own id', async () => {
    const skills = service(github({ 'acme/skills': acme(), 'bea/kit': 404 }), [
      { ...kept, id: 'acme/skills:pdf', origin: 'https://github.com/acme/skills' },
    ])
    const added = await skills.add({ kind: 'catalog', id: 'acme/skills:pdf' })
    expect(added).toMatchObject({ id: 'acme/skills:pdf', name: 'pdf', version: COMMIT })
    const [dir] = await readdir(path.join(root, 'marketplace', 'skills'))
    const text = await readFile(path.join(root, 'marketplace', 'skills', dir!, 'pdf', 'SKILL.md'))
    expect(text.toString()).toContain('name: pdf')
  })
})

describe("Kettu's own skills", () => {
  const flags: GuideFlags = {
    computer: false,
    market: false,
    suggest: true,
    memory: false,
    passwords: false,
  }
  const handed = [
    'kettu-artifacts',
    'kettu-sessions',
    'kettu-workflows',
    'kettu-browser',
    'kettu-devices',
    'kettu-terminals',
    'kettu-settings',
  ]

  function withOwn(
    agents: AgentId[],
    off: AgentId[] = [],
    kept: readonly MarketSkill[] = [],
    on: () => GuideFlags = () => flags,
  ) {
    return new MarketSkillsService({
      userDataPath: root,
      file: skillsCatalogFile(root, log),
      log,
      platform: 'darwin',
      home: root,
      settings: () => kept,
      agents: () => agents,
      configFolder: () => null,
      codexSkills: () => Promise.resolve(null),
      kettu: () => Promise.reject(new Error('not in this test')),
      repositories: REPOSITORIES,
      fetch: github({}),
      ownSkills: on,
      kettuOn: (agentId) => !off.includes(agentId),
    })
  }

  /** The skills under roots that each hold skills, as an agent finds them. */
  async function found(roots: readonly string[]): Promise<string[]> {
    const names = await Promise.all(roots.map((dir) => readdir(dir)))
    return names.flat().sort()
  }

  const own = () => path.join(root, 'marketplace', 'kettu-skills')

  it("go to Codex and OpenCode as one skill folder, only for a session that reaches Kettu's server", async () => {
    const skills = withOwn(['codex', 'opencode'])
    await skills.sync()
    const codex = await skills.sessionOptions('codex', true)
    expect(codex.skillRoots).toHaveLength(1)
    expect(await found(codex.skillRoots ?? [])).toEqual([...handed].sort())
    // Codex lists `<root>/<name>/SKILL.md`; a root named for the skill was read one level short.
    expect(path.basename(codex.skillRoots![0]!)).not.toMatch(/kettu/)
    for (const name of handed) {
      const text = await readFile(path.join(codex.skillRoots![0]!, name, 'SKILL.md'), 'utf8')
      expect(text).toContain(`name: ${name}`)
    }
    expect(await skills.sessionOptions('codex', false)).toEqual({ skillRoots: [] })
    const config = JSON.parse(skills.launchEnv('opencode', {}).OPENCODE_CONFIG_CONTENT ?? '{}')
    expect(config.skills).toEqual(codex.skillRoots)
    const off = withOwn(['opencode'], ['opencode'])
    expect(off.launchEnv('opencode', {}).OPENCODE_CONFIG_CONTENT).toBeUndefined()
  })

  it("go to Claude Code in Kettu's plugin, beside the Marketplace's skills", async () => {
    const kept: MarketSkill[] = []
    const skills = withOwn(['claude-code'], [], kept)
    const folder = path.join(root, 'own-pdf')
    await mkdir(folder)
    await writeFile(path.join(folder, 'SKILL.md'), skillMd('pdf'))
    kept.push(await skills.add({ kind: 'local', path: folder }))
    await skills.sync()
    const links = async (plugin: string) => (await readdir(path.join(plugin, 'skills'))).sort()
    const plain = (await skills.sessionOptions('claude-code', false)).localPlugins ?? []
    expect(plain).toHaveLength(1)
    expect(await links(plain[0]!)).toEqual(['pdf'])
    const own = (await skills.sessionOptions('claude-code', true)).localPlugins ?? []
    expect(own).toHaveLength(1)
    expect(await links(own[0]!)).toEqual([...handed, 'pdf'].sort())
    const manifest = await readFile(path.join(own[0]!, '.claude-plugin', 'plugin.json'), 'utf8')
    expect(JSON.parse(manifest).name).toBe('kettu')
    for (const name of handed) {
      const text = await readFile(path.join(own[0]!, 'skills', name, 'SKILL.md'), 'utf8')
      expect(text).toContain(`name: ${name}`)
    }
  })

  // A first start finds the agents after the first sync has run.
  it('reach a Claude Code agent added since the last sync with its first session', async () => {
    const agents: AgentId[] = []
    const skills = withOwn(agents)
    await skills.sync()
    agents.push('claude-code')
    const { localPlugins } = await skills.sessionOptions('claude-code', true)
    expect(await readdir(path.join(localPlugins![0]!, 'skills'))).toHaveLength(handed.length)
  })

  it('go to Pi as the skill folders its process starts with', async () => {
    const skills = withOwn(['pi', 'codex'])
    await skills.sync()
    const pi = await skills.sessionOptions('pi', true)
    expect(pi).toEqual(await skills.sessionOptions('codex', true))
    expect(pi.skillRoots).toHaveLength(1)
    expect(await skills.sessionOptions('pi', false)).toEqual({ skillRoots: [] })
    expect(skills.loadsSkills('pi')).toBe(true)
    expect(skills.sessionSkills('pi')).toBeNull()
  })

  it('go as no folder to an agent that loads none, which reads its skills with the tools', async () => {
    const kept: MarketSkill[] = []
    const skills = withOwn(['gemini', 'cline', 'deepseek', 'codex'], [], kept)
    for (const name of ['pdf', 'docx', 'off']) {
      const folder = path.join(root, `own-${name}`)
      await mkdir(folder)
      await writeFile(path.join(folder, 'SKILL.md'), skillMd(name))
      kept.push(await skills.add({ kind: 'local', path: folder }))
    }
    kept[1] = { ...kept[1]!, agents: ['codex'] }
    kept[2] = { ...kept[2]!, on: false }
    await skills.sync()
    for (const agent of ['gemini', 'cline', 'deepseek'] as const) {
      expect(await skills.sessionOptions(agent, true)).toEqual({})
      expect(skills.loadsSkills(agent)).toBe(false)
      expect(skills.launchEnv(agent, {})).toEqual({})
      const given = skills.sessionSkills(agent)!
      expect(given.map((skill) => skill.name)).toEqual(['pdf'])
      expect(await readFile(path.join(given[0]!.dir, 'SKILL.md'), 'utf8')).toContain('name: pdf')
    }
    // A workflow step's skill reaches its session whatever agent does it.
    expect(skills.sessionSkills('gemini', ['docx', 'off'])!.map((s) => s.name)).toEqual([
      'pdf',
      'docx',
    ])
    for (const agent of ['claude-code', 'codex', 'opencode'] as const) {
      expect(skills.sessionSkills(agent)).toBeNull()
    }
  })

  it('leave on disk only the folder of the features that are on, after an update', async () => {
    const stale = path.join(own(), 'kettu-workflows-0123456789', 'kettu-workflows')
    await mkdir(stale, { recursive: true })
    await writeFile(path.join(stale, 'SKILL.md'), skillMd('kettu-workflows'))
    await mkdir(path.join(own(), '.partial-left-by-a-crash'), { recursive: true })
    const skills = withOwn(['codex'])
    await skills.sync()
    const [current] = (await skills.sessionOptions('codex', true)).skillRoots!
    expect(await readdir(own())).toEqual([path.basename(current!)])
    expect(await readdir(current!)).toHaveLength(handed.length)
  })

  it('keep a folder an agent was handed until the next start, and write no other features', async () => {
    let now: GuideFlags = flags
    const skills = withOwn(['codex'], [], [], () => now)
    await skills.sync()
    const [before] = (await skills.sessionOptions('codex', true)).skillRoots!
    now = { ...flags, suggest: false }
    await skills.sync()
    const [after] = (await skills.sessionOptions('codex', true)).skillRoots!
    expect(after).not.toBe(before)
    expect((await readdir(own())).sort()).toEqual(
      [before, after].map((p) => path.basename(p!)).sort(),
    )
    const text = await readFile(path.join(after!, 'kettu-workflows', 'SKILL.md'), 'utf8')
    expect(text).not.toContain('suggest_workflow')
    await withOwn(['codex'], [], [], () => now).sync()
    expect(await readdir(own())).toEqual([path.basename(after!)])
  })
})
