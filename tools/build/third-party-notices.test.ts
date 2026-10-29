import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bundledPackages,
  collectNotices,
  packageDirOf,
  packedPackages,
  readNotice,
  renderNotices,
  type Notice,
} from './third-party-notices.ts'

describe('packageDirOf', () => {
  it("gives a module's package, scoped or not, through pnpm's folders", () => {
    expect(packageDirOf('/r/node_modules/.pnpm/react@19.0.0/node_modules/react/cjs/react.js')).toBe(
      '/r/node_modules/.pnpm/react@19.0.0/node_modules/react',
    )
    expect(
      packageDirOf(
        '/r/node_modules/.pnpm/@codemirror+view@6.0.0/node_modules/@codemirror/view/dist/index.js?x',
      ),
    ).toBe('/r/node_modules/.pnpm/@codemirror+view@6.0.0/node_modules/@codemirror/view')
    expect(packageDirOf('C:\\r\\node_modules\\a\\node_modules\\b\\index.js')).toBe(
      'C:/r/node_modules/a/node_modules/b',
    )
  })

  it("gives none for the app's own code and virtual modules", () => {
    expect(packageDirOf('/r/src/main/index.ts')).toBeNull()
    expect(packageDirOf('\0rolldown/runtime.js')).toBeNull()
    expect(packageDirOf('/r/node_modules/.vite/deps/x.js')).toBeNull()
  })
})

describe('bundledPackages', () => {
  it('takes the packages of the modules with code in a chunk, and none of the others', () => {
    const bundle = {
      'index.js': {
        type: 'chunk',
        modules: {
          '/r/node_modules/a/index.js': { renderedLength: 12 },
          '/r/node_modules/a/other.js': { renderedLength: 3 },
          '/r/node_modules/b/index.js': { renderedLength: 0 },
          '/r/src/index.ts': { renderedLength: 40 },
        },
      },
      'style.css': { type: 'asset' },
    }
    expect(bundledPackages(bundle)).toEqual(['/r/node_modules/a'])
  })
})

describe('the notices', () => {
  let root = ''

  async function pkg(dir: string, json: object, files: Record<string, string> = {}): Promise<void> {
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify(json))
    for (const [name, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true })
      await writeFile(path.join(dir, name), text)
    }
  }

  // pnpm's layout: each package in .pnpm with its dependencies beside it, linked from above.
  async function link(target: string, from: string): Promise<void> {
    await mkdir(path.dirname(from), { recursive: true })
    await symlink(target, from, 'junction')
  }

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kettu-notices-')))
    const store = path.join(root, 'node_modules', '.pnpm')
    const inStore = (id: string, name: string) => path.join(store, id, 'node_modules', name)
    await pkg(root, { dependencies: { a: '1', '@s/b': '2', 'node-pty': '1' } })
    await pkg(
      inStore('a@1.0.0', 'a'),
      {
        name: 'a',
        version: '1.0.0',
        license: 'MIT',
        dependencies: { c: '1' },
        optionalDependencies: { d: '1', 'not-installed': '1' },
      },
      { LICENSE: 'MIT License for a\n' },
    )
    await link(inStore('c@1.0.0', 'c'), inStore('a@1.0.0', 'c'))
    await link(inStore('d@1.0.0', 'd'), inStore('a@1.0.0', 'd'))
    await pkg(inStore('c@1.0.0', 'c'), { name: 'c', version: '1.0.0', license: 'ISC' })
    await pkg(
      inStore('d@1.0.0', 'd'),
      { name: 'd', version: '1.0.0', license: 'MIT' },
      { 'LICENSE.md': 'MIT License for d', NOTICE: 'Notice for d', 'README.md': 'Not a license' },
    )
    await pkg(
      inStore('@s+b@2.0.0', '@s/b'),
      { name: '@s/b', version: '2.0.0', license: { type: 'Apache-2.0' } },
      { LICENCE: 'Apache License for b' },
    )
    await pkg(
      inStore('node-pty@1.0.0', 'node-pty'),
      { name: 'node-pty', version: '1.0.0', license: 'MIT' },
      { LICENSE: 'MIT License for node-pty', 'deps/winpty/LICENSE': 'winpty license' },
    )
    await link(inStore('a@1.0.0', 'a'), path.join(root, 'node_modules', 'a'))
    await link(inStore('@s+b@2.0.0', '@s/b'), path.join(root, 'node_modules', '@s', 'b'))
    await link(inStore('node-pty@1.0.0', 'node-pty'), path.join(root, 'node_modules', 'node-pty'))
    await pkg(
      path.join(root, 'node_modules', 'electron'),
      { name: 'electron', version: '44.0.0', license: 'MIT' },
      { LICENSE: 'MIT License for Electron' },
    )
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const names = (dirs: string[]) => dirs.map((dir) => readNotice(dir).name).sort()

  it('packs a runtime dependency with its dependencies and the optional ones installed', () => {
    expect(names(packedPackages(root))).toEqual(['@s/b', 'a', 'c', 'd', 'node-pty'])
  })

  it('fails when a dependency is not installed', async () => {
    await pkg(root, { dependencies: { gone: '1' } })
    expect(() => packedPackages(root)).toThrow('gone')
  })

  it("brings a package's license and notice files with their text", () => {
    const d = readNotice(path.join(root, 'node_modules', '.pnpm', 'd@1.0.0', 'node_modules', 'd'))
    expect(d).toEqual({
      name: 'd',
      version: '1.0.0',
      license: 'MIT',
      files: [
        { name: 'LICENSE.md', text: 'MIT License for d' },
        { name: 'NOTICE', text: 'Notice for d' },
      ],
      lines: [],
    })
    expect(readNotice(path.join(root, 'node_modules', '@s', 'b'))).toMatchObject({
      license: 'Apache-2.0',
      files: [{ name: 'LICENCE', text: 'Apache License for b' }],
    })
  })

  it('lists a package without a license file by its license field, and says so', () => {
    const c = readNotice(path.join(root, 'node_modules', '.pnpm', 'c@1.0.0', 'node_modules', 'c'))
    expect(c).toMatchObject({ license: 'ISC', files: [] })
    expect(renderNotices([c])).toContain('c 1.0.0\nLicense: ISC\nIt ships no license file.\n')
  })

  it('fails the build, naming the package, when it has neither', async () => {
    const dir = path.join(root, 'node_modules', 'bare')
    await pkg(dir, { name: 'bare', version: '0.1.0' })
    expect(() => readNotice(dir)).toThrow('bare@0.1.0')
  })

  it('adds Electron, with where Chromium is, and winpty to node-pty', () => {
    const notices = collectNotices(root, [path.join(root, 'node_modules', 'a')])
    expect(notices.map((notice) => notice.name).sort()).toEqual([
      '@s/b',
      'a',
      'c',
      'd',
      'electron',
      'node-pty',
    ])
    expect(notices.find((notice) => notice.name === 'electron')?.lines[0]).toContain(
      'LICENSES.chromium.html',
    )
    expect(notices.find((notice) => notice.name === 'node-pty')?.files).toEqual([
      { name: 'LICENSE', text: 'MIT License for node-pty' },
      { name: 'deps/winpty/LICENSE', text: 'winpty license' },
    ])
  })
})

describe('renderNotices', () => {
  const notice = (name: string, version: string): Notice => ({
    name,
    version,
    license: 'MIT',
    files: [{ name: 'LICENSE', text: `License of ${name}` }],
    lines: [],
  })

  it('sorts the packages by name and lists each once', () => {
    const text = renderNotices([
      notice('zod', '3.0.0'),
      notice('@b/x', '1.0.0'),
      notice('react', '19.0.0'),
      notice('zod', '3.0.0'),
    ])
    const headings = text.split('\n').filter((line) => /^[@a-z].* \d+\.\d+\.\d+$/.test(line))
    expect(headings).toEqual(['@b/x 1.0.0', 'react 19.0.0', 'zod 3.0.0'])
  })
})
