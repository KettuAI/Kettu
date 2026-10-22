// The adapter install with the real npm, offline, from packages packed for the test.

import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Platform } from '@shared/platform'
import {
  binEntry,
  findInstalled,
  installAdapter,
  listInstalled,
  removeOtherVersions,
  runNpm,
  type InstallOptions,
} from './adapter-install'
import { findCommand, isExecutableFile, type Env } from './find-command'

const platform = process.platform as Platform
const PACKAGE = 'fake-adapter'
let tmp: string
let npm: string
let env: Env
const tarballs = new Map<string, string>()

async function packFixture(version: string, bin: unknown = { [PACKAGE]: 'index.js' }) {
  const dir = path.join(tmp, `fixture-${version}`)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: PACKAGE, version, bin, files: ['index.js'] }),
  )
  await writeFile(path.join(dir, 'index.js'), `#!/usr/bin/env node\nconsole.log('${version}')\n`)
  const packed = await runNpm({
    npm,
    args: ['pack', '--pack-destination', tmp],
    cwd: dir,
    env,
    platform,
    timeoutMs: 60_000,
  })
  expect(packed.code).toBe(0)
  tarballs.set(version, path.join(tmp, `${PACKAGE}-${version}.tgz`))
}

function options(root: string, version: string, extra: Partial<InstallOptions> = {}) {
  return {
    root,
    agentId: 'fake',
    package: PACKAGE,
    version,
    spec: `file:${tarballs.get(version)}`,
    npm,
    nodeVersion: process.version,
    platform,
    env,
    timeoutMs: 60_000,
    ...extra,
  } satisfies InstallOptions
}

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'overbench-install-'))
  const found = await findCommand('npm', {
    platform,
    env: process.env,
    isExecutable: (file) => isExecutableFile(file, platform),
  })
  if (!found) throw new Error('These tests need npm on PATH')
  npm = found
  env = { ...process.env, npm_config_offline: 'true', npm_config_cache: path.join(tmp, 'cache') }
  await packFixture('1.0.0')
  await packFixture('2.0.0')
}, 120_000)

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('installAdapter', () => {
  it('installs a version into its own directory and finds its entry', async () => {
    const root = await mkdtemp(path.join(tmp, 'root-'))
    const output: string[] = []
    const installed = await installAdapter(
      options(root, '1.0.0', { onOutput: (text) => output.push(text) }),
    )
    expect(installed.dir).toBe(path.join(root, 'fake', '1.0.0'))
    expect(installed.entry).toBe(path.join(installed.dir, 'node_modules', PACKAGE, 'index.js'))
    const record = JSON.parse(await readFile(path.join(installed.dir, 'installed.json'), 'utf8'))
    expect(record).toMatchObject({ package: PACKAGE, version: '1.0.0', node: process.version })
    expect(record.npm).toMatch(/^\d+\.\d+\.\d+/)
    expect(output.join('')).not.toBe('')
    expect(await readdir(path.join(root, 'fake'))).toEqual(['1.0.0'])
    expect(await findInstalled(root, 'fake', PACKAGE, '1.0.0')).toEqual(installed)
  }, 60_000)

  it('leaves nothing behind and reports npm when the install fails', async () => {
    const root = await mkdtemp(path.join(tmp, 'root-'))
    await expect(
      installAdapter(options(root, '1.0.0', { spec: `file:${path.join(tmp, 'missing.tgz')}` })),
    ).rejects.toThrow(/^npm exited with code \d+\. npm error/)
    expect(await readdir(path.join(root, 'fake'))).toEqual([])
  }, 60_000)

  it('deletes partial directories left long ago, but not one still being written', async () => {
    const root = await mkdtemp(path.join(tmp, 'root-'))
    const old = path.join(root, 'fake', '.partial-old')
    const fresh = path.join(root, 'fake', '.partial-fresh')
    await mkdir(old, { recursive: true })
    await mkdir(fresh)
    const hourAgo = new Date(Date.now() - 3_600_000)
    await utimes(old, hourAgo, hourAgo)
    await installAdapter(options(root, '1.0.0'))
    expect((await readdir(path.join(root, 'fake'))).sort()).toEqual(['.partial-fresh', '1.0.0'])
  }, 60_000)

  it('lists installed versions newest first and removes all but one', async () => {
    const root = await mkdtemp(path.join(tmp, 'root-'))
    await installAdapter(options(root, '1.0.0'))
    await installAdapter(options(root, '2.0.0'))
    await mkdir(path.join(root, 'fake', '3.0.0')) // never completed: no installed.json
    expect((await listInstalled(root, 'fake', PACKAGE)).map((a) => a.version)).toEqual([
      '2.0.0',
      '1.0.0',
    ])
    expect((await removeOtherVersions(root, 'fake', '2.0.0')).sort()).toEqual(['1.0.0', '3.0.0'])
    expect(await readdir(path.join(root, 'fake'))).toEqual(['2.0.0'])
  }, 60_000)

  describe('with an npm that never finishes', () => {
    let hangingNpm: string
    const pidFile = (): string => path.join(tmp, 'hanging-npm.pid')

    beforeAll(async () => {
      const script = path.join(tmp, 'hanging-npm.mjs')
      await writeFile(
        script,
        [
          "import { writeFileSync } from 'node:fs'",
          "if (process.argv[2] === '--version') { console.log('10.0.0'); process.exit(0) }",
          `writeFileSync(${JSON.stringify(pidFile())}, String(process.pid))`,
          "console.error('npm http fetch GET 200 https://registry.example/fake-adapter')",
          'setInterval(() => {}, 1000)',
        ].join('\n'),
      )
      if (platform === 'win32') {
        hangingNpm = path.join(tmp, 'hanging-npm.cmd')
        await writeFile(hangingNpm, `@"${process.execPath}" "${script}" %*\r\n`)
      } else {
        hangingNpm = path.join(tmp, 'hanging-npm')
        await writeFile(hangingNpm, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
        await chmod(hangingNpm, 0o755)
      }
    })

    const gone = async (): Promise<boolean> => {
      const pid = Number(await readFile(pidFile(), 'utf8'))
      for (let i = 0; i < 50; i++) {
        try {
          process.kill(pid, 0)
        } catch {
          return true
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return false
    }

    it('stops it with its process tree at the time limit', async () => {
      const root = await mkdtemp(path.join(tmp, 'root-'))
      await expect(
        installAdapter(options(root, '1.0.0', { npm: hangingNpm, timeoutMs: 1_000 })),
      ).rejects.toThrow('npm did not finish within 1 s.')
      expect(await gone()).toBe(true)
      expect(await readdir(path.join(root, 'fake'))).toEqual([])
    }, 30_000)

    it('stops it when the install is cancelled', async () => {
      const root = await mkdtemp(path.join(tmp, 'root-'))
      const abort = new AbortController()
      const install = installAdapter(
        options(root, '1.0.0', {
          npm: hangingNpm,
          signal: abort.signal,
          onOutput: (text) => {
            if (text.includes('fetch')) abort.abort()
          },
        }),
      )
      await expect(install).rejects.toThrow('The install was stopped.')
      expect(await gone()).toBe(true)
    }, 30_000)
  })
})

describe('binEntry', () => {
  async function manifest(bin: unknown, files: string[] = ['index.js', 'cli.js']) {
    const dir = await mkdtemp(path.join(tmp, 'bin-'))
    const packageDir = path.join(dir, 'node_modules', '@scope', 'tool')
    await mkdir(packageDir, { recursive: true })
    await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ bin }))
    for (const file of files) await writeFile(path.join(packageDir, file), '')
    return { dir, packageDir }
  }

  it('takes a lone entry, or the one named after the package without its scope', async () => {
    const lone = await manifest('cli.js')
    expect(await binEntry(lone.dir, '@scope/tool')).toBe(path.join(lone.packageDir, 'cli.js'))
    const named = await manifest({ other: 'index.js', tool: 'cli.js' })
    expect(await binEntry(named.dir, '@scope/tool')).toBe(path.join(named.packageDir, 'cli.js'))
  })

  it('refuses an entry outside the package or one that does not exist', async () => {
    const outside = await manifest('../../../evil.js')
    await writeFile(path.join(outside.dir, 'evil.js'), '')
    expect(await binEntry(outside.dir, '@scope/tool')).toBeNull()
    const missing = await manifest('gone.js')
    expect(await binEntry(missing.dir, '@scope/tool')).toBeNull()
  })
})
