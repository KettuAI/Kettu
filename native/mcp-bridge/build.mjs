// Builds kettu-mcp-bridge for this computer with Cargo and copies it into the directory given as
// the first argument. It has no dependencies, so it builds wherever Rust is installed.

import { spawnSync } from 'node:child_process'
import console from 'node:console'
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const NAME = process.platform === 'win32' ? 'kettu-mcp-bridge.exe' : 'kettu-mcp-bridge'

const destination = process.argv[2]
if (!destination) {
  console.error('usage: node native/mcp-bridge/build.mjs <destination directory>')
  process.exit(2)
}

const crate = path.dirname(fileURLToPath(import.meta.url))
const build = spawnSync('cargo', ['build', '--release', '--locked'], {
  cwd: crate,
  stdio: 'inherit',
  // cargo is an .exe on Windows, found on PATH without a shell.
  shell: false,
})
if (build.error) {
  if (build.error.code === 'ENOENT') {
    console.error(`cargo was not found on PATH; install Rust to build ${NAME}`)
  } else {
    console.error(`running cargo failed: ${build.error.message}`)
  }
  process.exit(1)
}
if (build.status !== 0) process.exit(build.status ?? 1)

mkdirSync(destination, { recursive: true })
const output = path.join(destination, NAME)
copyFileSync(path.join(crate, 'target', 'release', NAME), output)
chmodSync(output, 0o755)
console.log(`${NAME} -> ${output}`)
