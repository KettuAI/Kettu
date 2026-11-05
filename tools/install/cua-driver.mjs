// @ts-check
// Fetches Cua Driver's `cua-driver` program, which computer use runs, for one platform and
// architecture into resources/cua-driver/, with Cua's license and third-party notices for the
// notices file. Every download is pinned to the release and checked against its SHA-256 before it
// is used, and nothing downloaded is run. The release run calls it before the build; in a checkout,
// `pnpm fetch:cua-driver`. No dependencies beyond the system's tar, and lipo on macOS.
//
// Usage: node tools/install/cua-driver.mjs [--platform darwin|win32|linux] [--arch arm64|x64]

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const VERSION = '0.38.0'
const RELEASE = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${VERSION}`
/** The commit the release's tag names, for its license files. */
const COMMIT = '85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19'
const SOURCE = `https://raw.githubusercontent.com/trycua/cua/${COMMIT}`

/** @type {Record<string, { asset: string, sha256: string, lipo?: string }>} */
const PROGRAMS = {
  // One universal program for both Mac architectures, cut down to the target's.
  'darwin-arm64': {
    asset: `cua-driver-rs-${VERSION}-darwin-universal-binary.tar.gz`,
    sha256: '2bb8dc4a7e69185ffd04c4a9c0eab590bd2c54b72c2c1be13ab675be4f487732',
    lipo: 'arm64',
  },
  'darwin-x64': {
    asset: `cua-driver-rs-${VERSION}-darwin-universal-binary.tar.gz`,
    sha256: '2bb8dc4a7e69185ffd04c4a9c0eab590bd2c54b72c2c1be13ab675be4f487732',
    lipo: 'x86_64',
  },
  'linux-x64': {
    asset: `cua-driver-rs-${VERSION}-linux-x86_64-binary.tar.gz`,
    sha256: '31ab9709dd91ce73677e49b9f3e75c6f0d3e4d9625c286c9e58262bfbea698dd',
  },
  'linux-arm64': {
    asset: `cua-driver-rs-${VERSION}-linux-arm64-binary.tar.gz`,
    sha256: '80c9ae66bc7322052dd426c6133c96086b33894bf06c972bca8215384400b33d',
  },
  'win32-x64': {
    asset: `cua-driver-rs-${VERSION}-windows-x86_64-binary.zip`,
    sha256: '5edaa74d0afa1b55a9668dbc4f32736507bd2bd4d75b18ca1dc8881bb12402b5',
  },
  'win32-arm64': {
    asset: `cua-driver-rs-${VERSION}-windows-arm64-binary.zip`,
    sha256: 'd25c8ebfffb34e4c095ea170baf47b87c35dc0d1116f42e46b39df2bcbff8700',
  },
}

const NOTICES = [
  {
    url: `${SOURCE}/LICENSE.md`,
    file: 'LICENSE.md',
    sha256: 'c0779290c1d4783169aa3dbfb55feb505e563ef8a004bbf55298ceffcfbda8d9',
  },
  {
    url: `${SOURCE}/libs/cua-driver/rust/THIRD_PARTY_NOTICES.md`,
    file: 'THIRD_PARTY_NOTICES.md',
    sha256: '82470c85cb48dd084fccbf192d4a9f0b9d0afe614ab9b63e0fceac0eb315f412',
  },
]

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const out = join(root, 'resources', 'cua-driver')

/** @param {Buffer} bytes */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The bytes at `url`, refused unless they hash to `expected`.
 * @param {string} url
 * @param {string} expected
 */
async function download(url, expected) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const actual = sha256(bytes)
  if (actual !== expected) throw new Error(`${url}: SHA-256 ${actual}, expected ${expected}`)
  return bytes
}

/**
 * @param {string} command
 * @param {string[]} args
 */
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}`)
}

/** @param {string} path */
async function exists(path) {
  return stat(path).then(
    () => true,
    () => false,
  )
}

const { values } = parseArgs({
  options: { platform: { type: 'string' }, arch: { type: 'string' } },
})
const platform = values.platform ?? process.platform
const arch = values.arch ?? process.arch
const key = `${platform}-${arch}`
const program = PROGRAMS[key]
if (!program) throw new Error(`Cua Driver ${VERSION} has no program for ${key}`)
const name = platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'
const stamp = `${VERSION} ${key}\n`
const stampFile = join(out, 'version')

if (
  (await exists(join(out, name))) &&
  (await readFile(stampFile, 'utf8').catch(() => '')) === stamp
) {
  console.log(`Cua Driver ${VERSION} for ${key} is already in ${out}`)
} else {
  const work = await mkdtemp(join(tmpdir(), 'kettu-cua-driver-'))
  try {
    const archive = join(work, program.asset)
    await writeFile(archive, await download(`${RELEASE}/${program.asset}`, program.sha256))
    const unpacked = join(work, 'unpacked')
    await mkdir(unpacked)
    // bsdtar, which macOS and Windows ship as tar, reads the Windows zip too.
    run('tar', ['-xf', archive, '-C', unpacked, name])
    const extracted = join(unpacked, name)
    if (!(await exists(extracted))) throw new Error(`${program.asset} holds no ${name}`)
    await rm(out, { recursive: true, force: true })
    await mkdir(out, { recursive: true })
    const target = join(out, name)
    if (program.lipo && process.platform === 'darwin') {
      run('lipo', [extracted, '-thin', program.lipo, '-output', target])
      // Cutting the program voids Cua's signature; packaging signs it again with the app.
      run('codesign', ['--force', '--sign', '-', target])
    } else {
      await copyFile(extracted, target)
    }
    await chmod(target, 0o755)
    for (const notice of NOTICES) {
      await writeFile(join(out, notice.file), await download(notice.url, notice.sha256))
    }
    await writeFile(stampFile, stamp)
    console.log(`Fetched Cua Driver ${VERSION} for ${key} into ${out}`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
