import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Configuration, PlatformSpecificBuildOptions } from 'electron-builder'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../', import.meta.url))

type Stat = { isFile(): boolean; isDirectory(): boolean; moduleFullFilePath?: string }
type Filter = (file: string, stat: Stat) => boolean
type Matcher = { from: string; patterns: string[]; createFilter(): Filter }
type Packager = {
  config: Configuration
  projectDir: string
  buildResourcesDir: string
  isPrepackedAppAsar: boolean
  areNodeModulesHandledExternally: boolean
  debugLogger: { isEnabled: boolean }
}
type Expand = (pattern: string) => string

// electron-builder's own config loader, file matchers and file walker, so the files come out as a
// build copies them.
const builderRequire = createRequire(
  createRequire(import.meta.url).resolve('electron-builder/package.json'),
)
const { getConfig } = builderRequire('app-builder-lib/out/util/config/config') as {
  getConfig: (projectDir: string, configPath: string, options: null) => Promise<Configuration>
}
const { FileMatcher, getMainFileMatchers, getNodeModuleFileMatcher } = builderRequire(
  'app-builder-lib/out/fileMatcher',
) as {
  FileMatcher: new (from: string, to: string, expand: Expand, patterns: string[]) => Matcher
  getMainFileMatchers: (
    appDir: string,
    destination: string,
    expand: Expand,
    options: PlatformSpecificBuildOptions,
    platformPackager: { info: Packager },
    outDir: string,
    isElectronCompile: boolean,
  ) => Matcher[]
  getNodeModuleFileMatcher: (
    appDir: string,
    destination: string,
    expand: Expand,
    options: PlatformSpecificBuildOptions,
    packager: Packager,
  ) => Matcher
}
const { AppFileWalker } = builderRequire('app-builder-lib/out/util/AppFileWalker') as {
  AppFileWalker: new (
    matcher: Matcher,
    packager: Packager,
  ) => { filter: Filter; metadata: Map<string, Stat> }
}
const { walk } = builderRequire('builder-util') as {
  walk: (dir: string, filter: Filter, consumer: unknown) => Promise<string[]>
}

const PREBUILDS = { mac: 'darwin-', win: 'win32-', linux: null } as const
type Platform = keyof typeof PREBUILDS

const NODE_PTY = path.join(root, 'node_modules', 'node-pty')
const expand: Expand = (pattern) => pattern
let project = ''

const packager = (config: Configuration): Packager => ({
  config,
  projectDir: project,
  buildResourcesDir: config.directories?.buildResources ?? 'build',
  isPrepackedAppAsar: false,
  areNodeModulesHandledExternally: false,
  debugLogger: { isEnabled: false },
})

/** The project files a build copies into the app, walked as its file sets walk them. */
async function appFiles(config: Configuration, platform: Platform): Promise<string[]> {
  const info = packager(config)
  const matchers = getMainFileMatchers(
    project,
    '/app',
    expand,
    config[platform] ?? {},
    { info },
    path.join(project, 'dist'),
    false,
  )
  const files: string[] = []
  for (const matcher of matchers) {
    const walker = new AppFileWalker(matcher, info)
    for (const file of await walk(matcher.from, walker.filter, walker)) {
      if (walker.metadata.get(file)?.isFile()) {
        files.push(path.relative(project, file).split(path.sep).join('/'))
      }
    }
  }
  return files.sort()
}

/** node-pty's prebuilt binary folders that pass the filter a build copies node modules with. */
async function keptPrebuilds(config: Configuration, platform: Platform): Promise<string[]> {
  const modules = getNodeModuleFileMatcher(
    project,
    '/app',
    expand,
    config[platform] ?? {},
    packager(config),
  )
  const filter = new FileMatcher(
    NODE_PTY,
    '/app/node_modules/node-pty',
    expand,
    modules.patterns,
  ).createFilter()
  const names = await readdir(path.join(NODE_PTY, 'prebuilds'))
  return names.filter((name) =>
    filter(path.join(NODE_PTY, 'prebuilds', name), {
      isFile: () => false,
      isDirectory: () => true,
      moduleFullFilePath: `node_modules/node-pty/prebuilds/${name}`,
    }),
  )
}

beforeAll(async () => {
  project = await mkdtemp(path.join(os.tmpdir(), 'app-files-'))
  // A file in each of the repository's top-level entries, and a built out/ with its notices.
  const entries = await readdir(root, { withFileTypes: true })
  const files = [
    ...entries
      .filter((entry) => !['node_modules', 'out', 'dist'].includes(entry.name))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/file` : entry.name)),
    'out/main/index.js',
    'out/preload/index.mjs',
    'out/renderer/index.html',
    'out/third-party-notices.txt',
  ]
  for (const file of files) {
    await mkdir(path.dirname(path.join(project, file)), { recursive: true })
    await writeFile(path.join(project, file), '')
  }
})

afterAll(() => rm(project, { recursive: true, force: true }))

describe.each([
  ['electron-builder.yml', 'mac'],
  ['electron-builder.yml', 'win'],
  ['electron-builder.yml', 'linux'],
  ['electron-builder.mac-signed.yml', 'mac'],
] as const)('%s for %s', (file, platform) => {
  it('copies only out/, without the notices, and package.json from the project folder', async () => {
    expect(await appFiles(await getConfig(root, file, null), platform)).toEqual([
      'out/main/index.js',
      'out/preload/index.mjs',
      'out/renderer/index.html',
      'package.json',
    ])
  })

  it("keeps node-pty's prebuilt binaries for the target alone", async () => {
    const prefix = PREBUILDS[platform]
    const names = await readdir(path.join(NODE_PTY, 'prebuilds'))
    expect(await keptPrebuilds(await getConfig(root, file, null), platform)).toEqual(
      prefix ? names.filter((name) => name.startsWith(prefix)) : [],
    )
  })
})
