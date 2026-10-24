import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { usesPrebuilds } from './app-deps.mjs'

const nodePtyDir = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'))
const root = fileURLToPath(new URL('../../', import.meta.url))

type Manifest = {
  name: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

const manifest = (dir: string): Manifest =>
  JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest

/** Where Node.js finds `name` from `dir`: the nearest `node_modules` above it that holds it. */
function installed(name: string, dir: string): string | null {
  for (let at = dir; ; at = dirname(at)) {
    const candidate = join(at, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    if (dirname(at) === at) return null
  }
}

/**
 * The installed packages with a binding.gyp in the app's `dependencies` and
 * `optionalDependencies` tree, the ones install-app-deps rebuilds for Electron.
 */
function nativeModules(): string[] {
  const found = new Set<string>()
  const seen = new Set<string>()
  const visit = (dir: string): void => {
    const { name, dependencies = {}, optionalDependencies = {} } = manifest(dir)
    const deps = { ...dependencies, ...optionalDependencies }
    for (const dep of Object.keys(deps)) {
      const at = installed(dep, dir)
      if (!at) {
        // An optional dependency for another platform is not installed.
        if (dep in optionalDependencies) continue
        throw new Error(`${dep}, a dependency of ${name}, is not installed`)
      }
      if (seen.has(at)) continue
      seen.add(at)
      if (existsSync(join(at, 'binding.gyp'))) found.add(manifest(at).name)
      visit(at)
    }
  }
  visit(root)
  return [...found].sort()
}

describe('usesPrebuilds', () => {
  it('uses the binaries node-pty ships for Windows on x64 and arm64', () => {
    expect(usesPrebuilds('win32', 'x64', nodePtyDir)).toBe(true)
    expect(usesPrebuilds('win32', 'arm64', nodePtyDir)).toBe(true)
  })

  it('compiles for a Windows architecture node-pty ships nothing for', () => {
    expect(usesPrebuilds('win32', 'ia32', nodePtyDir)).toBe(false)
  })

  it('compiles on macOS even though node-pty ships binaries for it', () => {
    expect(usesPrebuilds('darwin', 'arm64', nodePtyDir)).toBe(false)
    expect(usesPrebuilds('darwin', 'x64', nodePtyDir)).toBe(false)
  })

  it('compiles on Linux', () => {
    expect(usesPrebuilds('linux', 'x64', nodePtyDir)).toBe(false)
  })

  // The reason macOS compiles; once node-pty ships it executable, its prebuilt binaries may do.
  it.skipIf(process.platform === 'win32')(
    "finds node-pty's prebuilt macOS spawn-helper not executable",
    () => {
      for (const arch of ['arm64', 'x64']) {
        const { mode } = statSync(join(nodePtyDir, 'prebuilds', `darwin-${arch}`, 'spawn-helper'))
        expect(mode & 0o111).toBe(0)
      }
    },
  )

  // Windows skips install-app-deps as a whole, which only node-pty, built against Node-API, allows.
  it('finds no native module but node-pty among what the app ships', () => {
    expect(
      nativeModules(),
      'Windows would ship a second native module built for Node.js: rebuild it in app-deps.mjs',
    ).toEqual(['node-pty'])
  })
})
