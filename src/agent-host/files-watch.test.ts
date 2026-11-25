import { mkdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Platform } from '@shared/platform'
import { FilesService } from './files'
import { FilesWatches } from './files-watch'
import type { Exec } from './git/exec'
import { tempFolder } from './testing/temp'

const platform = process.platform as Platform

const noGit: Exec = async () => ({
  code: null,
  stdout: '',
  stderr: '',
  failure: 'not-found',
  message: 'git is not installed',
})

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out waiting')
    await delay(20)
  }
}

async function setup(recursive?: boolean) {
  const root = path.join(await realpath(await tempFolder('kettu-files-watch-')), 'project')
  await mkdir(path.join(root, 'a', 'b'), { recursive: true })
  await writeFile(path.join(root, 'a', 'b', 'one.txt'), 'one')
  await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true })
  await mkdir(path.join(root, '.git', 'objects'), { recursive: true })
  await mkdir(path.join(root, 'dist'))
  const files = new FilesService({
    exec: noGit,
    platform,
    media: async () => null,
    describeMedia: async () => null,
    trash: async () => {},
  })
  const changes: { portId: string; projectPath: string }[] = []
  const watches = new FilesWatches({
    platform,
    changed: (portId, projectPath) => changes.push({ portId, projectPath }),
    log: () => {},
    debounceMs: 150,
    intervalMs: 600,
    ...(recursive === undefined ? {} : { recursive }),
  })
  const write = (relative: string, text = 'x') => writeFile(path.join(root, relative), text)
  // Lets the watchers start, so nothing from the setup is counted.
  const settle = async () => {
    await delay(400)
    changes.length = 0
  }
  return { root, files, changes, watches, write, settle }
}

describe.each([
  ['the platform default', undefined],
  ['a watcher per folder', false],
])('FilesWatches with %s', (_name, recursive) => {
  it('reports a burst of changes outside git once, and the list then has them', async () => {
    const { root, files, changes, watches, write, settle } = await setup(recursive)
    watches.add(root, 'port-1', root)
    watches.listed(root, await files.list(root))
    await settle()

    await write('two.txt')
    await write('a/b/three.txt')
    await mkdir(path.join(root, 'a', 'empty'))
    await until(() => changes.length > 0)
    await delay(900)
    try {
      expect(changes).toEqual([{ portId: 'port-1', projectPath: root }])
      const list = await files.list(root)
      expect(list.paths).toEqual(['a/b/one.txt', 'a/b/three.txt', 'two.txt'])
      expect(list.folders).toEqual(['a/empty', 'dist'])
    } finally {
      watches.stop()
    }
  }, 10_000)

  it('leaves out what is inside .git and node_modules, and an ignored folder until it is read', async () => {
    const { root, files, changes, watches, write, settle } = await setup(recursive)
    watches.add(root, 'port-1', root)
    watches.listed(root, { ...(await files.list(root)), ignoredFolders: ['dist'] })
    await settle()

    try {
      await write('node_modules/pkg/index.js')
      await write('.git/objects/ab')
      await write('dist/bundle.js')
      await delay(900)
      expect(changes).toEqual([])

      watches.read(root, 'dist')
      await delay(200)
      await write('dist/bundle.js', 'changed')
      await until(() => changes.length > 0)
      expect(changes).toEqual([{ portId: 'port-1', projectPath: root }])
    } finally {
      watches.stop()
    }
  }, 10_000)

  it('tells each port by the path it named, and stops once the last one lets go', async () => {
    const { root, files, changes, watches, write, settle } = await setup(recursive)
    watches.add(root, 'port-1', root)
    watches.add(root, 'port-2', `${root}${path.sep}`)
    watches.listed(root, await files.list(root))
    await settle()

    try {
      watches.remove(root, 'port-1')
      await write('one.txt')
      await until(() => changes.length > 0)
      await delay(700)
      expect(changes).toEqual([{ portId: 'port-2', projectPath: `${root}${path.sep}` }])

      changes.length = 0
      watches.dropPort('port-2')
      await write('two.txt')
      await delay(900)
      expect(changes).toEqual([])
    } finally {
      watches.stop()
    }
  }, 10_000)
})
