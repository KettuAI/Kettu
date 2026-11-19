import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseTerminalCommands, TerminalCommands } from './terminal-commands'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-terminal-commands-'))
  dirs.push(dir)
  return dir
}

const quiet = () => {}

describe('terminal-only commands', () => {
  it('knows nothing before a turn named them', async () => {
    const commands = new TerminalCommands(await tempDir(), quiet)
    await commands.load()
    expect(commands.namesFor('2.1.327')).toBeNull()
    expect(commands.namesFor(undefined)).toBeNull()
  })

  it('keeps what a turn named for its version only, across runs', async () => {
    const dir = await tempDir()
    const first = new TerminalCommands(dir, quiet)
    await first.load()
    first.remember('2.1.327', ['focus', 'doctor', 'focus'])
    await first.flush()
    expect(JSON.parse(await readFile(path.join(dir, 'terminal-commands.json'), 'utf8'))).toEqual({
      version: 1,
      claude: '2.1.327',
      names: ['doctor', 'focus'],
    })

    const next = new TerminalCommands(dir, quiet)
    await next.load()
    expect([...(next.namesFor('2.1.327') ?? [])]).toEqual(['doctor', 'focus'])
    // Another version may name others, so it waits for a turn of its own.
    expect(next.namesFor('2.1.328')).toBeNull()
  })

  it('keeps the latest version a turn ran, and an empty list as known', async () => {
    const commands = new TerminalCommands(undefined, quiet)
    commands.remember('2.1.327', ['doctor'])
    commands.remember('2.1.328', [])
    expect(commands.namesFor('2.1.327')).toBeNull()
    expect([...(commands.namesFor('2.1.328') ?? ['unset'])]).toEqual([])
  })

  it('lets a turn that ran while the file was read win over it', async () => {
    const dir = await tempDir()
    const first = new TerminalCommands(dir, quiet)
    first.remember('2.1.327', ['doctor'])
    await first.flush()
    const next = new TerminalCommands(dir, quiet)
    const loading = next.load()
    next.remember('2.1.328', ['color'])
    await loading
    expect([...(next.namesFor('2.1.328') ?? [])]).toEqual(['color'])
  })

  it('moves a file it cannot read aside and starts empty', async () => {
    const dir = await tempDir()
    await writeFile(
      path.join(dir, 'terminal-commands.json'),
      JSON.stringify({ version: 1, claude: 7, names: 'doctor' }),
    )
    const commands = new TerminalCommands(dir, quiet)
    await commands.load()
    expect(commands.namesFor('2.1.327')).toBeNull()
    expect((await readdir(dir)).some((name) => name.includes('.corrupt-'))).toBe(true)
  })

  it('accepts only a version or null and a list of names', () => {
    expect(parseTerminalCommands({ claude: null, names: [] })).toEqual({
      version: 1,
      claude: null,
      names: [],
    })
    expect(parseTerminalCommands({ claude: 3, names: [] })).toBeTypeOf('string')
    expect(parseTerminalCommands({ claude: '2.1.327', names: [1] })).toBeTypeOf('string')
  })
})
