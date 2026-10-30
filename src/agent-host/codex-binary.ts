// Codex's own binary inside an npm install of `@openai/codex`, which Kettu starts directly instead
// of through npm's `codex.js`, a Node.js process of its own (34 to 46 MB) that only finds the
// binary and forwards signals to it. The variables `codex.js` sets go along, so Codex still knows
// it was installed by npm.
// Lookup after @openai/codex 0.166.0's bin/codex.js (Apache-2.0, Copyright OpenAI):
// https://github.com/openai/codex/blob/main/codex-cli/bin/codex.js

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
  /** The package's bin entry. */
  entry: string
  platform: Platform
  /** The agent environment. */
  env: Env
  isFile?(file: string): Promise<boolean>
  realpath?(file: string): Promise<string>
}

/** Node.js's lookup of a package from `from`: each `node_modules` up to `top`, or to the root. */
async function findPackage(
  p: path.PlatformPath,
  name: string,
  from: string,
  top: string | null,
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

/** The platform's binary of the `@openai/codex` package at `codex`, as its `codex.js` finds it. */
export async function codexBinary(
  codex: string,
  platform: Platform,
  top: string | null,
  isFile: (file: string) => Promise<boolean>,
): Promise<string | null> {
  const p = platform === 'win32' ? path.win32 : path.posix
  const name = platform === 'win32' ? 'codex.exe' : 'codex'
  for (const target of TARGETS[platform] ?? []) {
    // Without the platform's package, codex.js looks in its own package's vendor folder.
    const vendor = (await findPackage(p, target.package, codex, top, isFile)) ?? codex
    const binary = p.join(vendor, 'vendor', target.triple, 'bin', name)
    if (await isFile(binary)) return binary
  }
  return null
}

/** What `codex.js` passes to the binary it starts for an npm install, rooted at its real path. */
export function npmCodexEnv(root: string): Record<string, string> {
  return { CODEX_MANAGED_BY_NPM: '1', CODEX_MANAGED_PACKAGE_ROOT: root }
}
