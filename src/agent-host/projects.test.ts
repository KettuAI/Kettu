import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Project } from '@shared/agent-host'
import { Projects } from './projects'
import { projectsFile } from './storage'

let dir: string
let clock: number

function makeProjects(): Projects {
  return new Projects({
    file: projectsFile(path.join(dir, 'data'), () => {}),
    platform: process.platform,
    now: () => ++clock,
  })
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), 'kettu-projects-')))
  clock = 1000
  await mkdir(path.join(dir, 'repo-a'))
  await mkdir(path.join(dir, 'repo-b'))
  await writeFile(path.join(dir, 'file.txt'), 'x')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('Projects', () => {
  it('adds canonical folders, newest first, and re-adding touches', async () => {
    const projects = makeProjects()
    await projects.load()
    const changes: Project[][] = []
    projects.onChange((list) => changes.push(list))
    const a = await projects.add(path.join(dir, 'repo-b', '..', 'repo-a') + path.sep)
    expect(a).toMatchObject({ path: path.join(dir, 'repo-a'), name: 'repo-a', missing: false })
    await projects.add(path.join(dir, 'repo-b'))
    expect(projects.list().map((p) => p.name)).toEqual(['repo-b', 'repo-a'])
    await projects.add(path.join(dir, 'repo-a'))
    expect(projects.list().map((p) => p.name)).toEqual(['repo-a', 'repo-b'])
    expect(projects.list()).toHaveLength(2)
    expect(changes).toHaveLength(3)
  })

  it('rejects relative paths, missing paths and files', async () => {
    const projects = makeProjects()
    await projects.load()
    await expect(projects.add('repo-a')).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(projects.add(path.join(dir, 'nope'))).rejects.toMatchObject({
      code: 'invalid_params',
    })
    await expect(projects.add(path.join(dir, 'file.txt'))).rejects.toMatchObject({
      code: 'invalid_params',
    })
    expect(projects.list()).toEqual([])
  })

  it('persists, and marks folders that disappeared as missing without dropping them', async () => {
    const projects = makeProjects()
    await projects.load()
    await projects.add(path.join(dir, 'repo-a'))
    await projects.add(path.join(dir, 'repo-b'))
    await projects.flush()
    await rm(path.join(dir, 'repo-b'), { recursive: true })

    const reloaded = makeProjects()
    await reloaded.load()
    expect(reloaded.list().map((p) => [p.name, p.missing])).toEqual([
      ['repo-b', true],
      ['repo-a', false],
    ])
    const missing = reloaded.match(path.join(dir, 'repo-b'))
    reloaded.remove(missing)
    expect(reloaded.list().map((p) => p.name)).toEqual(['repo-a'])
  })

  it('matches stored projects without realpath, for removal and touch', async () => {
    const projects = makeProjects()
    await projects.load()
    await projects.add(path.join(dir, 'repo-a'))
    expect(() => projects.match('relative')).toThrow(/absolute/)
    expect(() => projects.match(path.join(dir, 'other'))).toThrow(/No project/)
    const record = projects.match(path.join(dir, 'repo-a') + path.sep)
    const before = record.lastOpenedAt
    projects.touch(record)
    expect(record.lastOpenedAt).toBeGreaterThan(before)
  })
})
