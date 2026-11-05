// Builds kettu-ios-device for this Mac's architecture and copies it into the directory given as
// the first argument. The helper talks to iPhones and iPads through usbmuxd, so it is macOS only.

import { spawnSync } from 'node:child_process'
import console from 'node:console'
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const NAME = 'kettu-ios-device'
const TARGETS = { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' }

const destination = process.argv[2]
if (!destination) {
  console.error('usage: node native/ios-device/build.mjs <destination directory>')
  process.exit(2)
}
if (process.platform !== 'darwin') {
  console.log(`${NAME} is built on macOS only; skipping on ${process.platform}`)
  process.exit(0)
}
const target = TARGETS[process.arch]
if (!target) {
  console.error(`${NAME} cannot be built for ${process.arch}`)
  process.exit(1)
}

const crate = path.dirname(fileURLToPath(import.meta.url))
const build = spawnSync('cargo', ['build', '--release', '--locked', '--target', target], {
  cwd: crate,
  stdio: 'inherit',
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
copyFileSync(path.join(crate, 'target', target, 'release', NAME), output)
chmodSync(output, 0o755)
console.log(`${NAME} (${target}) -> ${output}`)
