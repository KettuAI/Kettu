import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { folderHooks } from './claude/project-hooks'
import { ProjectHooksAnswers } from './project-hooks'
import { parseProjectHooksFile, projectHooksFile } from './storage'

let dir: string
const stores: ProjectHooksAnswers[] = []

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kettu-project-hooks-'))
})

afterEach(async () => {
  // An answer's write may still be on its way to the folder.
  await Promise.all(stores.splice(0).map((store) => store.flush()))
  await rm(dir, { recursive: true, force: true })
})

async function answers(): Promise<ProjectHooksAnswers> {
  const store = new ProjectHooksAnswers(projectHooksFile(dir, () => {}))
  stores.push(store)
  await store.load()
  return store
}

describe("a folder's own hooks", () => {
  it('are held until the user answers for them, in that folder only', async () => {
    const store = await answers()
    expect(store.allowed('/repo', 'a')).toBeNull()
    store.answer('/repo', 'a', 'use')
    expect(store.allowed('/repo', 'a')).toBe(true)
    expect(store.allowed('/other', 'a')).toBeNull()
  })

  it('ask again once they change after a Run, but not after Always run or Don’t run', async () => {
    const store = await answers()
    store.answer('/repo', 'a', 'use')
    expect(store.allowed('/repo', 'b')).toBeNull()
    store.answer('/repo', 'b', 'all')
    expect(store.allowed('/repo', 'c')).toBe(true)
    store.answer('/repo', 'c', 'skip')
    expect(store.allowed('/repo', 'd')).toBe(false)
  })

  it('keep the answers in a file of their own across launches', async () => {
    const first = await answers()
    first.answer('/repo', 'a', 'use')
    first.answer('/skipped', 'b', 'skip')
    await first.flush()
    const second = await answers()
    expect(second.allowed('/repo', 'a')).toBe(true)
    expect(second.allowed('/skipped', 'x')).toBe(false)
  })

  it('drop an answer the file holds in a shape it does not know', () => {
    expect(
      parseProjectHooksFile({
        folders: {
          '/a': { decision: 'use', digest: 'x' },
          '/b': { decision: 'use' },
          '/c': { decision: 'all' },
          '/d': { decision: 'maybe' },
          '/e': 'skip',
        },
      }),
    ).toEqual({
      version: 1,
      folders: { '/a': { decision: 'use', digest: 'x' }, '/c': { decision: 'all' } },
    })
    expect(parseProjectHooksFile({})).toBe('folders is not an object')
  })
})

describe('reading the hooks a folder declares', () => {
  const project = (hooks: unknown) => ({ source: 'project', settings: { hooks } })

  it('reads only the project and local settings, and none when they declare none', () => {
    const user = { source: 'user', settings: { hooks: { Stop: [{ hooks: [{ command: 'x' }] }] } } }
    expect(folderHooks([user])).toBeNull()
    expect(folderHooks([user, project({})])).toBeNull()
    expect(
      folderHooks([
        user,
        project({ SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'a' }] }] }),
        {
          source: 'local',
          settings: {
            hooks: { PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ prompt: 'p' }] }] },
          },
        },
      ])?.hooks,
    ).toEqual([
      { event: 'SessionStart', target: 'a' },
      { event: 'PostToolUse (Edit|Write)', target: 'p' },
    ])
  })

  it('lists an event whose hooks it cannot read, as Claude Code may still run them', () => {
    expect(folderHooks([project({ SessionStart: 'run.sh' })])?.hooks).toEqual([
      { event: 'SessionStart', target: '' },
    ])
  })

  it('changes the digest with any change to a hook, past what the card shows', () => {
    const long = 'x'.repeat(400)
    const digest = (command: string) =>
      folderHooks([project({ SessionStart: [{ hooks: [{ command }] }] })])!.digest
    expect(digest(long)).toBe(digest(long))
    expect(digest(long)).not.toBe(digest(`${long}y`))
    expect(
      folderHooks([project({ SessionStart: [{ hooks: [{ command: long }] }] })])!.hooks[0]!.target,
    ).toHaveLength(300)
  })
})
