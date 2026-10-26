// A Vite plugin that writes out/third-party-notices.txt: every third-party package the app ships,
// each once, with its version, its license and the text of the license and notice files it ships.
// The packages are the ones with code in the main, preload and renderer bundles, the bundles main
// imports with `?modulePath`, which electron-vite builds with main's plugins, the runtime
// dependencies electron-builder packs, and Electron.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'

/** A shipped package as the notices list it. */
export interface Notice {
  name: string
  version: string
  /** Its package.json `license`, or null when it names none. */
  license: string | null
  /** Its license and notice files, by path from the package's folder, with their text. */
  files: { name: string; text: string }[]
  /** Lines under the license, such as where Chromium's licenses are. */
  lines: string[]
}

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[-._].*)?$/i
const RULE = '='.repeat(80)
const FILE_RULE = '-'.repeat(80)

/** The folder of the package a bundled module comes from, or null for the app's own code. */
export function packageDirOf(id: string): string | null {
  const file = id
    .replace(/^\0/, '')
    .replace(/[?#].*$/, '')
    .replaceAll('\\', '/')
  const at = file.lastIndexOf('/node_modules/')
  if (at < 0) return null
  const [first, second] = file.slice(at + '/node_modules/'.length).split('/')
  const name = first?.startsWith('@') ? [first, second] : [first]
  if (name.some((part) => !part || part.startsWith('.'))) return null
  return `${file.slice(0, at)}/node_modules/${name.join('/')}`
}

/** The packages of the modules that have code in a bundle's chunks. */
export function bundledPackages(bundle: Record<string, unknown>): string[] {
  const dirs = new Set<string>()
  for (const output of Object.values(bundle) as BundleOutput[]) {
    if (output.type !== 'chunk') continue
    for (const [id, module] of Object.entries(output.modules)) {
      if (module.renderedLength === 0) continue
      const dir = packageDirOf(id)
      if (dir) dirs.add(dir)
    }
  }
  return [...dirs]
}

interface BundleOutput {
  type: string
  modules: Record<string, { renderedLength: number }>
}

interface PackageJson {
  name?: unknown
  version?: unknown
  license?: unknown
  licenses?: unknown
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

function readPackage(dir: string): PackageJson {
  return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as PackageJson
}

/** Where Node finds `name` from `from`: the nearest `node_modules` up the tree that holds it. */
function locate(from: string, name: string): string | null {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name)
    if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate)
    if (path.dirname(dir) === dir) return null
  }
}

/**
 * The folders of the packages electron-builder packs: the root's `dependencies` and, in turn, the
 * dependencies and optional dependencies of each, as installed. An optional one not installed, as
 * for another platform, is not packed either.
 */
export function packedPackages(root: string): string[] {
  const found = new Set<string>()
  const visit = (from: string, required: string[], optional: string[]): void => {
    for (const name of [...required, ...optional]) {
      const dir = locate(from, name)
      if (!dir) {
        if (required.includes(name)) throw new Error(`${name}, a dependency, is not installed`)
        continue
      }
      if (found.has(dir)) continue
      found.add(dir)
      const pkg = readPackage(dir)
      visit(dir, Object.keys(pkg.dependencies ?? {}), Object.keys(pkg.optionalDependencies ?? {}))
    }
  }
  const pkg = readPackage(root)
  visit(root, Object.keys(pkg.dependencies ?? {}), Object.keys(pkg.optionalDependencies ?? {}))
  return [...found]
}

function licenseOf(pkg: PackageJson): string | null {
  if (typeof pkg.license === 'string' && pkg.license.trim()) return pkg.license.trim()
  if (isTyped(pkg.license)) return pkg.license.type
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses.filter(isTyped).map((license) => license.type)
    if (types.length > 0) return types.join(' OR ')
  }
  return null
}

function isTyped(value: unknown): value is { type: string } {
  return (
    typeof value === 'object' && value !== null && typeof Reflect.get(value, 'type') === 'string'
  )
}

/** A package's notice: its name, version, license and the license and notice files it ships. */
export function readNotice(dir: string): Notice {
  const pkg = readPackage(dir)
  const name = typeof pkg.name === 'string' ? pkg.name : path.basename(dir)
  const version = typeof pkg.version === 'string' ? pkg.version : 'unknown'
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((file) => ({ name: file, text: readFileSync(path.join(dir, file), 'utf8').trim() }))
  const license = licenseOf(pkg)
  if (files.length === 0 && !license) {
    throw new Error(`${name}@${version} ships no license file and names no license`)
  }
  return { name, version, license, files, lines: [] }
}

/** The notices for the bundled packages, the packed ones and Electron, each package once. */
export function collectNotices(root: string, bundled: Iterable<string>): Notice[] {
  const dirs = new Set([...bundled].map((dir) => realpathSync(dir)))
  for (const dir of packedPackages(root)) dirs.add(dir)
  const notices = [...dirs].map((dir) => {
    const notice = readNotice(dir)
    // node-pty's Windows binaries include winpty, whose license the packaged app leaves out.
    const winpty = path.join(dir, 'deps', 'winpty', 'LICENSE')
    if (notice.name === 'node-pty' && existsSync(winpty)) {
      notice.files.push({ name: 'deps/winpty/LICENSE', text: readFileSync(winpty, 'utf8').trim() })
    }
    return notice
  })
  const electron = locate(root, 'electron')
  if (!electron) throw new Error('electron is not installed')
  const notice = readNotice(electron)
  notice.lines.push(
    'Chromium and the libraries it uses: see LICENSES.chromium.html, installed with OverBench.',
  )
  notices.push(notice)
  return notices
}

/** The text of out/third-party-notices.txt: the notices sorted by name, each package once. */
export function renderNotices(notices: Notice[]): string {
  const unique = new Map(notices.map((notice) => [`${notice.name}@${notice.version}`, notice]))
  const sorted = [...unique.values()].sort(
    (a, b) => compare(a.name, b.name) || compare(a.version, b.version),
  )
  const parts = [
    'Third-party notices for OverBench\n\n' +
      'OverBench ships the packages below. Each is listed with its version, its license and the ' +
      'license and notice files it ships.\n',
  ]
  for (const notice of sorted) {
    let entry = `${RULE}\n${notice.name} ${notice.version}\nLicense: ${notice.license ?? 'none named'}\n`
    for (const line of notice.lines) entry += `${line}\n`
    if (notice.files.length === 0) entry += 'It ships no license file.\n'
    for (const file of notice.files) entry += `${FILE_RULE}\n${file.name}\n\n${file.text}\n`
    parts.push(entry)
  }
  return parts.join('\n')
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The plugin for each of the three builds. They share what they saw, and each production build
 * writes the file afresh, so the last one's holds all three; a development run, which builds main
 * and the preload script for the dev server, writes nothing.
 */
export function thirdPartyNotices(root: string): () => Plugin {
  const bundled = new Set<string>()
  return () => {
    let write = false
    return {
      name: 'overbench:third-party-notices',
      apply: 'build',
      configResolved(config) {
        write = config.mode === 'production' && !config.build.watch
      },
      generateBundle(_, bundle) {
        for (const dir of bundledPackages(bundle)) bundled.add(dir)
      },
      closeBundle() {
        if (!write) return
        const out = path.join(root, 'out')
        mkdirSync(out, { recursive: true })
        writeFileSync(
          path.join(out, 'third-party-notices.txt'),
          renderNotices(collectNotices(root, bundled)),
        )
      },
    }
  }
}
