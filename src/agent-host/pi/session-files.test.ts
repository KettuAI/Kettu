// Where Kettu finds Pi's session files: by the session's id, wherever pi put the file.

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findSessionFile,
  folderName,
  listSessionFiles,
  piFolders,
  type PiFolders,
} from './session-files'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function folders(): Promise<PiFolders & { root: string }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kettu-pi-files-')))
  dirs.push(root)
  return {
    root,
    sessions: path.join(root, 'sessions'),
    adapterMap: path.join(root, 'session-map.json'),
  }
}

async function write(dir: string, name: string, lines: unknown[]): Promise<string> {
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  await writeFile(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''))
  return file
}

const header = (id: string, cwd: string) => ({ type: 'session', version: 3, id, cwd })

describe("pi's folders", () => {
  it('names a working directory as pi does', () => {
    expect(folderName('/Users/me/my project')).toBe('--Users-me-my project--')
    expect(folderName('C:\\Users\\me\\app')).toBe('--C--Users-me-app--')
  })

  it('follows the environment, then the settings, then the agent folder', async () => {
    const { root } = await folders()
    const agent = path.join(root, 'agent')
    await mkdir(agent, { recursive: true })
    const env = { HOME: root, PI_CODING_AGENT_DIR: agent }
    expect((await piFolders(env, 'darwin')).sessions).toBe(path.join(agent, 'sessions'))
    await writeFile(path.join(agent, 'settings.json'), JSON.stringify({ sessionDir: 'kept' }))
    expect((await piFolders(env, 'darwin')).sessions).toBe(path.join(agent, 'kept'))
    const named = { ...env, PI_CODING_AGENT_SESSION_DIR: path.join(root, 'elsewhere') }
    expect((await piFolders(named, 'darwin')).sessions).toBe(path.join(root, 'elsewhere'))
    expect((await piFolders(env, 'darwin')).adapterMap).toBe(
      path.join(root, '.pi', 'pi-acp', 'session-map.json'),
    )
  })
})

describe('finding a session file', () => {
  it('finds it in the folder of its working directory, by its name and its header', async () => {
    const at = await folders()
    const own = path.join(at.sessions, folderName('/work/app'))
    const file = await write(own, '2026-11-19T10-00-00-000Z_abc.jsonl', [
      header('abc', '/work/app'),
    ])
    // A file named for the session that starts another is not it.
    await write(own, '2026-11-19T09-00-00-000Z_abd.jsonl', [header('zzz', '/work/app')])
    expect(await findSessionFile(at, '/work/app', 'abc')).toBe(file)
    expect(await findSessionFile(at, '/work/app', 'abd')).toBeNull()
    expect(await findSessionFile(at, '/work/app', 'ab')).toBeNull()
  })

  it('finds it in another folder, as after the working directory moved', async () => {
    const at = await folders()
    const file = await write(
      path.join(at.sessions, folderName('/old/place')),
      '2026-11-01T10-00-00-000Z_moved.jsonl',
      [header('moved', '/old/place')],
    )
    expect(await findSessionFile(at, '/new/place', 'moved')).toBe(file)
    expect(await findSessionFile(at, null, 'moved')).toBe(file)
  })

  it("falls back to the adapter's map, when the file it names is the session's", async () => {
    const at = await folders()
    const file = await write(path.join(at.root, 'out'), 'kept.jsonl', [
      header('mapped', '/work/app'),
    ])
    const other = await write(path.join(at.root, 'out'), 'other.jsonl', [
      header('else', '/work/app'),
    ])
    await writeFile(
      at.adapterMap,
      JSON.stringify({
        version: 1,
        sessions: {
          mapped: { sessionId: 'mapped', cwd: '/work/app', sessionFile: file },
          wrong: { sessionFile: other },
          relative: { sessionFile: 'kept.jsonl' },
        },
      }),
    )
    expect(await findSessionFile(at, '/work/app', 'mapped')).toBe(file)
    expect(await findSessionFile(at, '/work/app', 'wrong')).toBeNull()
    expect(await findSessionFile(at, '/work/app', 'relative')).toBeNull()
    expect(await findSessionFile(at, '/work/app', 'unknown')).toBeNull()
  })
})

describe('listing the sessions of a folder', () => {
  it('lists them latest first, each titled by its name or its first prompt', async () => {
    const at = await folders()
    const own = path.join(at.sessions, folderName('/work/app'))
    const prompt = (text: string, timestamp: string) => ({
      type: 'message',
      id: 'u',
      parentId: null,
      timestamp,
      message: { role: 'user', content: [{ type: 'text', text }] },
    })
    await write(own, 'a_one.jsonl', [
      header('one', '/work/app'),
      prompt('Fix the login page', '2026-11-18T10:00:00.000Z'),
    ])
    await write(own, 'b_two.jsonl', [
      header('two', '/work/app'),
      prompt('Something long', '2026-11-19T10:00:00.000Z'),
      {
        type: 'session_info',
        id: 'n',
        parentId: 'u',
        timestamp: '2026-11-19T11:00:00.000Z',
        name: 'Named ',
      },
    ])
    // Another directory's session that ended up in the folder is not this one's.
    await write(own, 'c_three.jsonl', [header('three', '/work/other')])
    expect(await listSessionFiles(at, '/work/app')).toEqual([
      { sessionId: 'two', title: 'Named', updatedAt: '2026-11-19T11:00:00.000Z', cwd: '/work/app' },
      {
        sessionId: 'one',
        title: 'Fix the login page',
        updatedAt: '2026-11-18T10:00:00.000Z',
        cwd: '/work/app',
      },
    ])
    expect(await listSessionFiles(at, '/work/none')).toEqual([])
  })
})
