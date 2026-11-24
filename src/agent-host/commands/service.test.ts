import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { PluginResource } from '@shared/plugins'
import { promptBlocks } from '../connection'
import { tempFolder } from '../testing/temp'
import { CommandsService, USER_COMMANDS_DIR, type KeptTool } from './service'

let dir: string

beforeEach(async () => {
  dir = await tempFolder('kettu-commands-')
})

const REVIEW = `---
description: Review a file
arguments:
  - name: file
skills: [code-review]
mcp: [github]
---
Review {{file}} for bugs.
`

async function userFile(name: string, text: string): Promise<void> {
  const folder = path.join(dir, USER_COMMANDS_DIR)
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
    path: `sh.kettu/commands/${name}.md`,
    pluginId: `p${plugin}`,
    pluginName: plugin,
    plugin: `Plugin ${plugin}`,
    file,
  }
}

function service(
  options: { plugins?: PluginResource[]; skills?: KeptTool[]; mcp?: KeptTool[] } = {},
): { service: CommandsService; logged: string[] } {
  const logged: string[] = []
  return {
    logged,
    service: new CommandsService({
      userDataPath: dir,
      plugins: async () => options.plugins ?? [],
      kept: () => ({
        skills: options.skills ?? [{ id: 'local:1', name: 'code-review', on: true }],
        mcp: options.mcp ?? [{ id: 'manual:1', name: 'github', on: true }],
      }),
      log: (_level, message) => logged.push(message),
    }),
  }
}

const none = new Set<string>()

describe('listing commands', () => {
  it('lists the user’s own and the plugins’, each with where it comes from', async () => {
    await userFile('review.md', REVIEW)
    await userFile('notes.txt', 'not a command')
    const plugin = await pluginFile('kit', 'ship', 'Ship it.')
    const { service: commands } = service({ plugins: [plugin] })
    expect(await commands.list()).toEqual([
      {
        name: 'review',
        description: 'Review a file',
        inputHint: '<file>',
        origin: { kind: 'user' },
      },
      {
        name: 'ship',
        description: '',
        origin: { kind: 'plugin', id: 'pkit', name: 'kit', title: 'Plugin kit' },
      },
    ])
  })

  it('leaves out a file that does not read, saying so in the log', async () => {
    await userFile('broken.md', '---\narguments: nope\n---\nbody')
    const { service: commands, logged } = service()
    expect(await commands.list()).toEqual([])
    expect(logged.join('\n')).toMatch(/broken\.md/)
  })

  it('lists none when the user has no folder yet', async () => {
    expect(await service().service.list()).toEqual([])
  })
})

describe('expanding a command', () => {
  it('gives the same plain message whichever agent sends it', async () => {
    await userFile('review.md', REVIEW)
    const { service: commands } = service()
    const found = await commands.expand('/review src/a.ts', none)
    expect(found).toEqual({
      run: { name: 'review', origin: { kind: 'user' }, sent: 'Review src/a.ts for bugs.' },
      needs: { skills: ['code-review'], mcp: ['github'] },
    })
    // Every agent's prompt is built from the content by this one function.
    const part = { type: 'text' as const, text: '/review src/a.ts', command: found!.run }
    expect(promptBlocks([part])).toEqual([{ type: 'text', text: 'Review src/a.ts for bugs.' }])
    expect(promptBlocks([{ type: 'text', text: '/review src/a.ts' }])).toEqual([
      { type: 'text', text: '/review src/a.ts' },
    ])
  })

  it('goes to the user’s command when a plugin has the name, and the qualified name picks one', async () => {
    await userFile('ship.md', 'User ship.')
    const plugin = await pluginFile('kit', 'ship', 'Plugin ship.')
    const { service: commands } = service({ plugins: [plugin] })
    expect((await commands.expand('/ship', none))?.run.sent).toBe('User ship.')
    expect((await commands.expand('/kit:ship', none))?.run).toMatchObject({
      name: 'ship',
      sent: 'Plugin ship.',
      origin: { kind: 'plugin', name: 'kit' },
    })
    expect((await commands.expand('/user:ship', none))?.run.sent).toBe('User ship.')
    expect(await commands.expand('/other:ship', none)).toBeNull()
  })

  it('leaves a name the agent has itself to the agent', async () => {
    await userFile('compact.md', 'Mine.')
    const { service: commands } = service()
    expect(await commands.expand('/compact now', new Set(['compact']))).toBeNull()
    expect((await commands.expand('/user:compact now', new Set(['compact']))) !== null).toBe(true)
  })

  it('takes no text that is not a command of Kettu’s', async () => {
    await userFile('ship.md', 'Ship.')
    const { service: commands } = service()
    for (const text of ['hello /ship', '/unknown x', '/', '//ship', '/shipping']) {
      expect(await commands.expand(text, none)).toBeNull()
    }
  })

  it('refuses a command whose required argument has no value', async () => {
    await userFile('review.md', REVIEW)
    const { service: commands } = service()
    await expect(commands.expand('/review', none)).rejects.toMatchObject({
      code: 'invalid_params',
      message: expect.stringContaining('file') as unknown,
    })
  })

  it('refuses a command whose skills or servers are not installed or are turned off', async () => {
    await userFile('review.md', REVIEW)
    const missing = service({ skills: [], mcp: [{ id: 'manual:1', name: 'github', on: false }] })
    const error = await missing.service.expand('/review a.ts', none).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'invalid_params' })
    const message = (error as Error).message
    expect(message).toContain('code-review')
    expect(message).toContain('isn’t installed')
    expect(message).toContain('github')
    expect(message).toContain('turned off')
  })

  it('finds a skill or server by its id as well as its name', async () => {
    await userFile('review.md', REVIEW.replace('[code-review]', '[local:1]'))
    const { service: commands } = service()
    expect((await commands.expand('/review a.ts', none))?.needs.skills).toEqual(['local:1'])
  })
})
