// Codex's own binary inside an installed codex-acp. With `CODEX_PATH` the adapter starts it
// directly instead of through npm's `codex.js`, a Node.js process of its own (34 to 46 MB) that
// only finds the binary and forwards signals to it. The variables `codex.js` sets go along, so
// Codex still knows it was installed by npm.
// Lookup after @openai/codex 0.160.1's bin/codex.js (Apache-2.0, Copyright OpenAI):
// https://github.com/openai/codex/blob/main/codex-cli/bin/codex.js

import { realpath as fsRealpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import type { Env } from './find-command'

// Each platform's binaries by architecture; npm installs the one package that fits its Node.js.
const TARGETS: Partial<Record<Platform, { package: string; triple: string }[]>> = {
  darwin: [
    { package: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin' },
    { package: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin' },
  ],
  linux: [
    { package: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl' },
    { package: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' },
  ],
  win32: [
    { package: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
    { package: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' },
  ],
}

/** An installed adapter, for a catalog entry's `launchEnv`. */
export interface AdapterLookup {
  /** The installed version's directory, which holds its `node_modules`. */
  dir: string
  /** codex-acp's entry, where the lookup starts as Node.js's would. */
  entry: string
  platform: Platform
  /** The agent environment. */
  env: Env
  isFile?(file: string): Promise<boolean>
  realpath?(file: string): Promise<string>
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

/** Node.js's lookup of a package from `from`: each `node_modules` up to the install directory. */
async function findPackage(
  p: path.PlatformPath,
  name: string,
  from: string,
  top: string,
  exists: (file: string) => Promise<boolean>,
): Promise<string | null> {
  for (let dir = from; ; dir = p.dirname(dir)) {
    if (p.basename(dir) !== 'node_modules') {
      const candidate = p.join(dir, 'node_modules', name)
      if (await exists(p.join(candidate, 'package.json'))) return candidate
    }
    if (dir === top || p.dirname(dir) === dir) return null
  }
}

/**
 * `CODEX_PATH`, `CODEX_MANAGED_BY_NPM` and `CODEX_MANAGED_PACKAGE_ROOT` for codex-acp, or nothing
 * when the binary is not where npm puts it, and the adapter goes through `codex.js` as before.
 */
export async function codexLaunchEnv(lookup: AdapterLookup): Promise<Record<string, string>> {
  const targets = TARGETS[lookup.platform]
  // A `CODEX_PATH` the user set wins.
  if (!targets || lookup.env.CODEX_PATH) return {}
  const p = lookup.platform === 'win32' ? path.win32 : path.posix
  const exists = lookup.isFile ?? isFile
  const codex = await findPackage(p, '@openai/codex', p.dirname(lookup.entry), lookup.dir, exists)
  if (!codex) return {}
  const name = lookup.platform === 'win32' ? 'codex.exe' : 'codex'
  for (const target of targets) {
    const vendor = await findPackage(p, target.package, codex, lookup.dir, exists)
    const binary = vendor && p.join(vendor, 'vendor', target.triple, 'bin', name)
    if (!binary || !(await exists(binary))) continue
    let root: string
    try {
      root = await (lookup.realpath ?? fsRealpath)(codex)
    } catch {
      return {}
    }
    return { CODEX_PATH: binary, CODEX_MANAGED_BY_NPM: '1', CODEX_MANAGED_PACKAGE_ROOT: root }
  }
  return {}
}
