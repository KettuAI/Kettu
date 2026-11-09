import {
  mkdir,
  readdir,
  readFile,
  readlink,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { MarketSkill } from '@shared/marketplace'
import type { AgentId } from '@shared/thread'
import { tarball } from '../testing/tarball'
import { tempFolder } from '../testing/temp'
import {
  MarketSkillsService,
  opencodeEnv,
  prunable,
  PRUNE_GRACE_MS,
  skillFolder,
  skillInfo,
  skillsCatalogFile,
} from './skills'

const SKILL = (name: string, description = `The ${name} skill`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`

function catalogTar(): Buffer {
  return gzipSync(
    tarball([
      { name: 'skills-main/skills/pdf/SKILL.md', data: SKILL('pdf') },
      { name: 'skills-main/skills/pdf/scripts/fill.py', data: 'print(1)' },
      { name: 'skills-main/skills/xlsx/SKILL.md', data: SKILL('xlsx') },
      { name: 'skills-main/template/SKILL.md', data: SKILL('template') },
    ]),
  )
}

async function setup(agents: AgentId[] = ['claude-code', 'codex', 'opencode', 'pi']) {
  const dir = await tempFolder('kettu-skills-')
  const state = { skills: [] as MarketSkill[], now: 1_000_000, asked: [] as string[] }
  const service = new MarketSkillsService({
    userDataPath: path.join(dir, 'data'),
    file: skillsCatalogFile(path.join(dir, 'data'), () => {}),
    log: () => {},
    platform: 'darwin',
    home: path.join(dir, 'home'),
    settings: () => state.skills,
    agents: () => agents,
    configFolder: (agentId) => path.join(dir, 'config', agentId),
    codexSkills: async () => null,
    fetch: (async (url: string) => {
      state.asked.push(String(url))
      return new Response(catalogTar())
    }) as unknown as typeof fetch,
    now: () => state.now,
  })
  return { dir, state, service, store: path.join(dir, 'data', 'marketplace', 'skills') }
}

describe('skills', () => {
  it('reads the catalog from the repository and copies a skill of it onto the host', async () => {
    const { state, service, store } = await setup()
    const skills = await service.skills()
    expect(skills.error).toBeNull()
    expect(skills.catalog.map((skill) => skill.id)).toEqual([
      'anthropics/skills:pdf',
      'anthropics/skills:xlsx',
    ])
    expect(skills.catalog[0]).toMatchObject({
      official: true,
      repository: 'https://github.com/anthropics/skills',
      version: '2c5958ecac7cee2b583967a2c4981d0f4a75c579',
    })
    expect(state.asked).toEqual([
      'https://codeload.github.com/anthropics/skills/tar.gz/refs/heads/main',
    ])
    await service.skills()
    expect(state.asked).toHaveLength(1)

    const pdf = await service.add({ kind: 'catalog', id: 'anthropics/skills:pdf' })
    expect(pdf).toMatchObject({ name: 'pdf', source: 'catalog', agents: 'all', on: true })
    const copied = path.join(store, skillFolder(pdf.id), 'pdf')
    expect(await readFile(path.join(copied, 'scripts', 'fill.py'), 'utf8')).toBe('print(1)')
  }, 20_000)

  it('takes exactly one skill from a GitHub folder', async () => {
    const { service } = await setup()
    const one = await service.add({
      kind: 'github',
      url: 'https://github.com/anthropics/skills/tree/main/skills/xlsx',
    })
    expect(one).toMatchObject({
      id: 'github:anthropics/skills/skills/xlsx',
      name: 'xlsx',
      origin: 'https://github.com/anthropics/skills',
    })
    await expect(
      service.add({ kind: 'github', url: 'https://github.com/anthropics/skills' }),
    ).rejects.toThrow(/holds 3 skills/)
    await expect(
      service.add({ kind: 'github', url: 'https://github.com/anthropics/skills/tree/main/docs' }),
    ).rejects.toThrow(/no SKILL.md/)
  })

  it('copies a local folder, refusing one with a link or without a SKILL.md', async () => {
    const { dir, service } = await setup()
    const folder = path.join(dir, 'mine')
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'SKILL.md'), SKILL('mine'))
    const skill = await service.add({ kind: 'local', path: folder })
    expect(skill).toMatchObject({ source: 'local', origin: folder, version: null, name: 'mine' })
    expect(skill.id).toMatch(/^local:[0-9a-f-]{36}$/)

    await symlink('/etc/hosts', path.join(folder, 'hosts'))
    await expect(service.add({ kind: 'local', path: folder })).rejects.toThrow(/link/)
    const empty = path.join(dir, 'empty')
    await mkdir(empty)
    await expect(service.add({ kind: 'local', path: empty })).rejects.toThrow(/no SKILL.md/)
  })

  it('hands each agent its skills: roots to Codex, a plugin to Claude Code, config to OpenCode', async () => {
    const { state, service, store } = await setup()
    const pdf = await service.add({ kind: 'catalog', id: 'anthropics/skills:pdf' })
    const xlsx = await service.add({ kind: 'catalog', id: 'anthropics/skills:xlsx' })
    state.skills = [pdf, { ...xlsx, agents: ['codex'] }]
    await service.sync()

    expect(service.sessionOptions('codex')).toEqual({
      skillRoots: [path.join(store, skillFolder(pdf.id)), path.join(store, skillFolder(xlsx.id))],
    })
    const { localPlugins } = service.sessionOptions('claude-code')
    expect(localPlugins).toHaveLength(1)
    const plugin = localPlugins![0]!
    expect(
      JSON.parse(await readFile(path.join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')),
    ).toMatchObject({ name: 'kettu' })
    expect(await readdir(path.join(plugin, 'skills'))).toEqual(['pdf'])
    expect(await readlink(path.join(plugin, 'skills', 'pdf'))).toBe(
      path.join(store, skillFolder(pdf.id), 'pdf'),
    )
    expect(service.launchEnv('opencode', { PATH: '/bin' })).toEqual({
      PATH: '/bin',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ skills: [path.join(store, skillFolder(pdf.id))] }),
    })
    // pi-acp starts pi with fixed arguments, so Pi gets none of them.
    expect(service.sessionOptions('pi')).toEqual({})

    state.skills = [{ ...pdf, on: false }]
    await service.sync()
    expect(service.sessionOptions('claude-code')).toEqual({})
    await expect(stat(plugin)).rejects.toThrow()
  })

  it('removes the folder of a skill that left the settings once the grace has passed', async () => {
    const { state, service, store } = await setup()
    const pdf = await service.add({ kind: 'catalog', id: 'anthropics/skills:pdf' })
    const folder = path.join(store, skillFolder(pdf.id))
    await service.sync()
    expect(await readdir(store)).toEqual([skillFolder(pdf.id)])
    const written = (await stat(folder)).mtimeMs
    state.now = written + PRUNE_GRACE_MS + 1
    await service.sync()
    expect(await readdir(store)).toEqual([])

    const again = await service.add({ kind: 'catalog', id: 'anthropics/skills:pdf' })
    state.skills = [again]
    const old = new Date(0)
    await utimes(folder, old, old)
    state.now = Date.now() + PRUNE_GRACE_MS * 10
    await service.sync()
    expect(await readdir(store)).toEqual([skillFolder(again.id)])
  })
})

describe('prunable', () => {
  it('keeps what the settings name and what was written in the last ten minutes', () => {
    const now = 100 * 60_000
    const folders = [
      { name: 'kept', modifiedAt: 0 },
      { name: 'old', modifiedAt: 0 },
      { name: 'fresh', modifiedAt: now - PRUNE_GRACE_MS + 1 },
      { name: 'just-past', modifiedAt: now - PRUNE_GRACE_MS },
    ]
    expect(prunable(folders, new Set(['kept']), now)).toEqual(['old', 'just-past'])
  })
})

describe('skillInfo', () => {
  it('takes the name and description from the frontmatter, or refuses the skill', () => {
    expect(skillInfo(SKILL('pdf', 'Reads  PDFs'), 'x')).toEqual({
      name: 'pdf',
      description: 'Reads PDFs',
    })
    expect(skillInfo('---\ndescription: d\n---', 'folder-name')).toMatchObject({
      name: 'folder-name',
    })
    expect(() => skillInfo(SKILL('Bad Name'), 'x')).toThrow(/not a skill name/)
    expect(() => skillInfo('---\nname: pdf\n---', 'x')).toThrow(/no description/)
  })
})

describe('opencodeEnv', () => {
  it("adds Kettu's skill folders to the user's own inline configuration", () => {
    const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'x', skills: ['/mine'] }) }
    expect(JSON.parse(opencodeEnv(env, ['/kettu']).OPENCODE_CONFIG_CONTENT!)).toEqual({
      model: 'x',
      skills: ['/mine', '/kettu'],
    })
    const legacy = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ skills: { paths: ['/mine'] } }) }
    expect(JSON.parse(opencodeEnv(legacy, ['/kettu']).OPENCODE_CONFIG_CONTENT!)).toEqual({
      skills: ['/mine', '/kettu'],
    })
    expect(opencodeEnv({ OPENCODE_CONFIG_CONTENT: 'not json' }, ['/kettu'])).toEqual({
      OPENCODE_CONFIG_CONTENT: 'not json',
    })
    expect(opencodeEnv({ PATH: '/bin' }, [])).toEqual({ PATH: '/bin' })
  })
})
