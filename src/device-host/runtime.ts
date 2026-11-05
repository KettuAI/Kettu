// Where the device host finds the programs it runs: npm packages it loads at runtime, the helpers
// shipped in the app's resources, and the Node.js it runs them with.

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import path from 'node:path'
import { isExecutableFile } from '../agent-host/find-command'

const require = createRequire(__filename)

/** Packaged apps keep native modules and executables outside the archive, where they can run. */
export function unpacked(file: string): string {
  return file.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
}

/**
 * The root folder of an installed npm package, found where Node.js would look for it, since a
 * package's `exports` may give `require` nothing to resolve.
 */
export function packageRoot(name: string): string {
  for (const dir of require.resolve.paths(name) ?? []) {
    const root = path.join(dir, name)
    if (existsSync(path.join(root, 'package.json'))) return unpacked(root)
  }
  throw new Error(`${name} is not installed with Kettu`)
}

/** How to run a Node.js script: this process's own runtime, as Node.js under Electron. */
export function nodeCommand(env: NodeJS.ProcessEnv): { file: string; env: NodeJS.ProcessEnv } {
  if (process.versions.electron) {
    return { file: process.execPath, env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
  }
  return { file: process.execPath, env }
}

/** A loopback port nothing listens on now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('No free port'))))
    })
  })
}

/**
 * A helper Kettu builds: from the app's resources when packaged, from `out/helpers` in
 * development. Null when it is not there, as on a platform it is not built for.
 */
export async function helperPath(
  name: string,
  resourcesPath: string | null,
): Promise<string | null> {
  const candidates = [
    ...(resourcesPath ? [path.join(resourcesPath, 'helpers', name)] : []),
    path.resolve(__dirname, '..', 'helpers', name),
    path.resolve(__dirname, '..', '..', 'out', 'helpers', name),
  ]
  for (const file of candidates) {
    if (await isExecutableFile(file, process.platform)) return file
  }
  return null
}
