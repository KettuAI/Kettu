// @ts-check
// Builds kettu-ios-usb-capture, the macOS helper that streams the screen of an iPhone or iPad
// connected over USB, for this Mac's architecture and copies it into the directory given as the
// first argument. Elsewhere it builds nothing. No dependencies.

import { spawnSync } from 'node:child_process'
import console from 'node:console'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const NAME = 'kettu-ios-usb-capture'
// Electron 44's own minimum.
const MINIMUM_MACOS = '13.0'
const ARCHITECTURES = { arm64: 'arm64', x64: 'x86_64' }

function main() {
  const destination = process.argv[2]
  if (!destination) {
    console.error('usage: node build.mjs <destination directory>')
    return 2
  }
  if (process.platform !== 'darwin') {
    console.log(`${NAME}: macOS only, nothing to build on ${process.platform}`)
    return 0
  }
  const arch = ARCHITECTURES[/** @type {keyof typeof ARCHITECTURES} */ (process.arch)]
  if (!arch) {
    console.error(`${NAME}: no build for the ${process.arch} architecture`)
    return 1
  }

  const swiftc = spawnSync('xcrun', ['--sdk', 'macosx', '--find', 'swiftc'], { encoding: 'utf8' })
  if (swiftc.error || swiftc.status !== 0) {
    const detail = swiftc.error?.message ?? swiftc.stderr.trim()
    console.error(
      `${NAME}: the Swift toolchain was not found (${detail}). Install Xcode or the Command Line ` +
        'Tools with xcode-select --install.',
    )
    return 1
  }

  const here = dirname(fileURLToPath(import.meta.url))
  const sourceDir = join(here, 'Sources')
  const sources = readdirSync(sourceDir)
    .filter((name) => name.endsWith('.swift'))
    .sort()
    .map((name) => join(sourceDir, name))
  const work = mkdtempSync(join(tmpdir(), `${NAME}-`))
  try {
    const output = join(work, NAME)
    const result = spawnSync(
      'xcrun',
      [
        '--sdk',
        'macosx',
        'swiftc',
        '-O',
        '-swift-version',
        '5',
        '-target',
        `${arch}-apple-macos${MINIMUM_MACOS}`,
        '-o',
        output,
        ...sources,
      ],
      { stdio: 'inherit' },
    )
    if (result.error) throw result.error
    if (result.status !== 0) {
      console.error(`${NAME}: swiftc failed`)
      return result.status ?? 1
    }
    const target = join(resolve(destination), NAME)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(output, target)
    chmodSync(target, 0o755)
    console.log(`${NAME}: built ${target} (${arch})`)
    return 0
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

process.exitCode = main()
