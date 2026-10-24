// @ts-check
// The postinstall step that readies node-pty, the app's only native module, for Electron. It is a
// Node-API module, so a binary built for Node.js loads in Electron as it is. On Windows the app uses
// the prebuilt binaries node-pty ships, which spares a compile of one and a half to three minutes
// per install. Elsewhere electron-builder install-app-deps compiles it: node-pty 1.1.0 ships no
// Linux binaries, and its prebuilt macOS spawn-helper lacks its execute bit, so no shell would start
// (microsoft/node-pty#919). A second native module would need this revisited. No dependencies.

import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

/**
 * Whether the app loads node-pty's own prebuilt binaries for this platform and architecture,
 * instead of a build from source.
 *
 * @param {NodeJS.Platform} platform
 * @param {string} arch
 * @param {string} nodePtyDir
 */
export function usesPrebuilds(platform, arch, nodePtyDir) {
  return platform === 'win32' && existsSync(join(nodePtyDir, 'prebuilds', `${platform}-${arch}`))
}

// import.meta.main is missing before Node.js 22.18; the main module's URL is its real path.
const isMain =
  import.meta.main ?? realpathSync(process.argv[1] ?? '.') === fileURLToPath(import.meta.url)

if (isMain) {
  const nodePtyDir = dirname(require.resolve('node-pty/package.json'))
  if (usesPrebuilds(process.platform, process.arch, nodePtyDir)) {
    console.log(`node-pty: using its prebuilt binaries for ${process.platform}-${process.arch}`)
  } else {
    const cli = require.resolve('electron-builder/cli.js')
    const result = spawnSync(process.execPath, [cli, 'install-app-deps'], { stdio: 'inherit' })
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
  }
}
