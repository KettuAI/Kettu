import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { PluginResource } from '@shared/plugins'
import type { KeptTool } from '../commands/service'
import { tempFolder } from '../testing/temp'
import { RolesService, USER_ROLES_DIR } from './service'

let dir: string

beforeEach(async () => {
  dir = await tempFolder('kettu-roles-')
})

const REVIEWER = `---
name: Reviewer
description: Reviews a change
agent: codex
model: gpt-5
skills: [code-review]
---
Review the change.
`

async function userFile(name: string, text: string): Promise<void> {
  const folder = path.join(dir, USER_ROLES_DIR)
  await mkdir(folder, { recursive: true })
  await writeFile(path.join(folder, name), text)
}

async function pluginFile(plugin: string, name: string, text: string): Promise<PluginResource> {
  const file = path.join(dir, 'plugins', plugin, `${name}.md`)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text)
  return {
    name,
    description: '',
    path: `sh.kettu/roles/${name}.md`,
    pluginId: `p${plugin}`,
    pluginName: plugin,
    plugin: `Plugin ${plugin}`,
    file,
  }
}

function service(options: { plugins?: PluginResource[]; skills?: KeptTool[] } = {}) {
  const logged: string[] = []
  return {
    logged,
    service: new RolesService({
      userDataPath: dir,
      plugins: async () => options.plugins ?? [],
      kept: () => ({
        skills: options.skills ?? [{ id: 'local:1', name: 'code-review', on: true }],
        mcp: [],
      }),
      log: (_level, message) => logged.push(message),
    }),
  }
}

describe('listing roles', () => {
  it('lists the user’s own and the plugins’, each with its suggestions and where it comes from', async () => {
    await userFile('reviewer.md', REVIEWER)
    await userFile('notes.txt', 'not a role')
    const plugin = await pluginFile('kit', 'docs-editor', 'Edit the docs.')
    const { service: roles } = service({ plugins: [plugin] })
    expect(await roles.list()).toEqual([
      {
        ref: 'reviewer',
        title: 'Reviewer',
        description: 'Reviews a change',
        suggests: { agent: 'codex', model: 'gpt-5' },
        origin: { kind: 'user' },
      },
      {
        ref: 'docs-editor',
        title: 'docs-editor',
        description: '',
        suggests: {},
        origin: { kind: 'plugin', id: 'pkit', name: 'kit', title: 'Plugin kit' },
      },
    ])
  })

  it('qualifies the reference of a name two roles share, and the user’s wins the bare name', async () => {
    await userFile('ship.md', 'User ship.')
    const plugin = await pluginFile('kit', 'ship', 'Plugin ship.')
    const { service: roles } = service({ plugins: [plugin] })
    expect((await roles.list()).map((role) => role.ref)).toEqual(['user:ship', 'kit:ship'])
    expect((await roles.find('ship'))?.instructions).toBe('User ship.')
    expect((await roles.find('kit:ship'))?.instructions).toBe('Plugin ship.')
    expect(await roles.find('other:ship')).toBeNull()
  })

  it('leaves out a file that does not read, saying so in the log', async () => {
    await userFile('broken.md', '---\nskills: nope\n---\nbody')
    await userFile('empty.md', '---\nname: Empty\n---\n')
    const { service: roles, logged } = service()
    expect(await roles.list()).toEqual([])
    expect(logged.join('\n')).toMatch(/broken\.md/)
  })
})

describe('resolving a role', () => {
  it('gives the instructions and what the role needs', async () => {
    await userFile('reviewer.md', REVIEWER)
    expect(await service().service.resolve('reviewer')).toEqual({
      ref: 'reviewer',
      title: 'Reviewer',
      instructions: 'Review the change.',
      suggests: { agent: 'codex', model: 'gpt-5' },
      needs: { skills: ['code-review'], mcp: [] },
    })
  })

  it('refuses a role that does not exist', async () => {
    await expect(service().service.resolve('nobody')).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('refuses a role whose skill is not installed or is turned off, naming it', async () => {
    await userFile('reviewer.md', REVIEWER)
    const missing = await service({ skills: [] })
      .service.resolve('reviewer')
      .catch((error: unknown) => error)
    expect(missing).toMatchObject({ code: 'invalid_params' })
    expect((missing as Error).message).toContain('code-review')
    const off = await service({ skills: [{ id: 'local:1', name: 'code-review', on: false }] })
      .service.resolve('reviewer')
      .catch((error: unknown) => error)
    expect((off as Error).message).toContain('turned off')
  })
})
