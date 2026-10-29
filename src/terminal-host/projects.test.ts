import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pathKey, ProjectRegistry } from './projects'

describe('ProjectRegistry', () => {
  let dir: string | null = null
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = null
  })

  it('matches a project through a symlink and a trailing slash', async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'kettu-projects-')))
    const project = join(dir, 'app')
    await mkdir(project)
    // Creating a symlink needs extra privileges on Windows.
    if (process.platform !== 'win32') await symlink(project, join(dir, 'link'))
    const registry = new ProjectRegistry(process.platform)
    registry.set([project, join(dir, 'gone')])
    expect(await registry.match(`${project}/`)).toEqual({ projectPath: project, cwd: project })
    if (process.platform !== 'win32') {
      expect(await registry.match(join(dir, 'link'))).toEqual({
        projectPath: project,
        cwd: project,
      })
    }
    expect(await registry.match(join(dir, 'gone'))).toBeNull()
    expect(await registry.match(dir)).toBeNull()
    expect(await registry.match('app')).toBeNull()
  })

  it('compares Windows paths without case', async () => {
    const canonical = async (path: string): Promise<string> => path.replace(/^c:/, 'C:')
    const registry = new ProjectRegistry('win32', canonical)
    registry.set(['C:\\Work\\App'])
    expect(await registry.match('c:\\work\\app\\')).toEqual({
      projectPath: 'C:\\Work\\App',
      cwd: 'C:\\Work\\App',
    })
    expect(await registry.match('C:\\Work\\Other')).toBeNull()
  })

  it('keys paths per platform', () => {
    expect(pathKey('C:\\A', 'win32')).toBe('c:\\a')
    expect(pathKey('/A', 'linux')).toBe('/A')
  })
})
