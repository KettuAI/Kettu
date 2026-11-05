// Puts the device host's helpers in a folder, `out/helpers` by default: scrcpy's server for
// Android, downloaded at a pinned version and checked by its SHA-256, and on macOS the two iOS
// helpers built from `native/`. The release run calls it before packaging, which ships the folder
// as the app's `helpers` resource; `pnpm fetch:device-helpers` does the same for development.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const out = path.resolve(process.argv[2] ?? path.join(root, 'out', 'helpers'))

const SCRCPY_VERSION = '5.0.1'
const SCRCPY_SHA256 = '764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536'
const SCRCPY_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}`

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function scrcpyServer() {
  const file = path.join(out, 'scrcpy-server')
  const existing = await readFile(file).catch(() => null)
  if (existing && sha256(existing) === SCRCPY_SHA256) {
    console.log('scrcpy-server: already in place')
    return
  }
  const response = await fetch(SCRCPY_URL)
  if (!response.ok) throw new Error(`scrcpy-server: download failed (${response.status})`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const actual = sha256(bytes)
  if (actual !== SCRCPY_SHA256) {
    throw new Error(`scrcpy-server: SHA-256 ${actual} is not the pinned ${SCRCPY_SHA256}`)
  }
  await writeFile(`${file}.partial`, bytes)
  await rename(`${file}.partial`, file)
  // helperPath only takes executable files; the server is pushed to the device, never run here.
  await chmod(file, 0o755)
  console.log(`scrcpy-server: v${SCRCPY_VERSION} checked and saved`)
}

function build(helper) {
  const script = path.join(root, 'native', helper, 'build.mjs')
  const result = spawnSync(process.execPath, [script, out], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${helper}: build failed`)
}

await mkdir(out, { recursive: true })
await scrcpyServer()
if (process.platform === 'darwin') {
  build('ios-usb-capture')
  build('ios-device')
}
