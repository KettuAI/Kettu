import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RELEASES_ENV } from '../daemon/update'
import { CHECKSUMS, INSTALL_SCRIPT, SignedReleaseError } from '../daemon/signed-release'
import { keyPair, releasesFetch, signedFiles, type TestPlace } from '../daemon/testing/releases'
import { installRun, verifiedInstallRun } from './ssh'

const release = keyPair()
const stranger = keyPair()

const DOWNLOADS = 'https://download.kettu.sh'
const GITHUB = 'https://github.com/KettuAI/Kettu/releases'

const SUMS = `${'c'.repeat(64)}  kettu-daemon-linux-x64.tar.gz\n`
const signed = (key = release.privateKey) =>
  signedFiles('0.2.0', { [INSTALL_SCRIPT]: '#!/bin/sh\n', [CHECKSUMS]: SUMS }, key)
const place = (files: Record<string, string>): TestPlace => ({ latest: '0.2.0', files })

function requests(places: Record<string, TestPlace>) {
  const { fetch, requests } = releasesFetch(places)
  return { requests, deps: { fetch, userAgent: 'test', keys: [release.raw] } }
}

/** The line that sets the checksums in the script the app sends, which the script then reads. */
const checksumsLine = (script: string) =>
  script.split('\n').find((l) => l.startsWith('KETTU_CHECKSUMS='))

describe('the script the desktop app runs to install the daemon over SSH', () => {
  it('carries the checksums it verified, quoted for sh, and the release place it was told', async () => {
    const { deps, requests: asked } = requests({ [DOWNLOADS]: place(signed()) })
    const script = await verifiedInstallRun('0.2.0', deps, {})
    expect(script).toContain(`KETTU_CHECKSUMS='${SUMS.trimEnd()}\n'`)
    expect(script).toContain('export KETTU_CHECKSUMS')
    expect(script).not.toContain(`${RELEASES_ENV}=`)
    expect(asked).toEqual([
      `${DOWNLOADS}/download/v0.2.0/${CHECKSUMS}`,
      `${DOWNLOADS}/download/v0.2.0/${CHECKSUMS}.sig`,
    ])
  })

  it('takes GitHub when the download service signs nothing that holds', async () => {
    const { deps } = requests({
      [DOWNLOADS]: place(signed(stranger.privateKey)),
      [GITHUB]: place(signed()),
    })
    const script = await verifiedInstallRun('0.2.0', deps, {})
    expect(checksumsLine(script)).toBeDefined()
  })

  it('takes only the place KETTU_RELEASES_URL names, and passes it on', async () => {
    const mirror = 'https://mirror.example/releases'
    const { deps, requests: asked } = requests({
      [DOWNLOADS]: place(signed()),
      [mirror]: place(signed()),
    })
    const script = await verifiedInstallRun('0.2.0', deps, { [RELEASES_ENV]: mirror })
    expect(asked.every((url) => url.startsWith(mirror))).toBe(true)
    expect(script).toContain(`${RELEASES_ENV}=${mirror}`)
  })

  it('fails, with every place reason, when none serves checksums signed with the release key', async () => {
    const { deps } = requests({
      [DOWNLOADS]: place(signed(stranger.privateKey)),
      [GITHUB]: place({}),
    })
    const failure = await verifiedInstallRun('0.2.0', deps, {}).catch((e: Error) => e)
    expect(failure).toBeInstanceOf(SignedReleaseError)
    expect((failure as Error).message).toMatch(/does not hold/)
    expect((failure as Error).message).toMatch(/it answered 404/)
  })

  it('fails when the one place KETTU_RELEASES_URL names signs nothing, not trying others', async () => {
    const mirror = 'https://mirror.example/releases'
    const { deps, requests: asked } = requests({
      [DOWNLOADS]: place(signed()),
      [mirror]: place({}),
    })
    await expect(verifiedInstallRun('0.2.0', deps, { [RELEASES_ENV]: mirror })).rejects.toThrow()
    expect(asked.every((url) => url.startsWith(mirror))).toBe(true)
  })
})

const system = (() => {
  const os = { Linux: 'linux', Darwin: 'darwin' }[process.platform === 'linux' ? 'Linux' : 'Darwin']
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : null
  const supported =
    (process.platform === 'linux' || process.platform === 'darwin') &&
    arch !== null &&
    // The script refuses Intel Macs.
    !(os === 'darwin' && arch === 'x64')
  return { supported, name: `kettu-daemon-${os}-${arch}` }
})()

const folders: string[] = []

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

/**
 * A release folder laid out as GitHub's that holds only the package, which reports version 0.2.0,
 * and a HOME with nothing installed; `sums` is the checksum file, when the folder serves one.
 */
function setup(sums?: (hash: string) => string) {
  const root = mkdtempSync(path.join(tmpdir(), 'kettu-install-'))
  folders.push(root)
  const home = path.join(root, 'home')
  mkdirSync(home)
  const source = path.join(root, 'package', system.name, 'bin')
  mkdirSync(source, { recursive: true })
  writeFileSync(path.join(source, 'kettu'), '#!/bin/sh\necho 0.2.0\n', { mode: 0o755 })
  const folder = path.join(root, 'releases', 'download', 'v0.2.0')
  mkdirSync(folder, { recursive: true })
  const file = `${system.name}.tar.gz`
  const tar = spawnSync('tar', [
    '-czf',
    path.join(folder, file),
    '-C',
    path.join(root, 'package'),
    system.name,
  ])
  expect(tar.status).toBe(0)
  const hash = createHash('sha256')
    .update(spawnSync('cat', [path.join(folder, file)], { maxBuffer: 1 << 26 }).stdout)
    .digest('hex')
  if (sums) writeFileSync(path.join(folder, 'kettu-daemon-sha256sums.txt'), sums(hash))
  return {
    home,
    hash,
    file,
    releases: `file://${path.join(root, 'releases')}`,
    linked: () => existsSync(path.join(home, '.local', 'bin', 'kettu')),
  }
}

const sh = (input: string | null, args: string[], home: string, env: Record<string, string>) =>
  spawnSync('sh', input === null ? args : ['-s'], {
    input: input ?? undefined,
    cwd: home,
    env: { HOME: home, PATH: '/usr/bin:/bin', ...env },
    encoding: 'utf8',
  })

const INSTALL = path.resolve('tools/daemon/install.sh')

describe.skipIf(!system.supported)('the install script with checksums given', () => {
  it('installs when the script the app sends checks the package against them, with none downloaded', () => {
    const t = setup()
    const given = `0000  some-file's name.tar.gz\n${t.hash}  ${t.file}\n`
    const script = installRun('0.2.0', given, { [RELEASES_ENV]: t.releases })
    const run = sh(script, [], t.home, {})
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('Installed the Kettu daemon 0.2.0')
    expect(t.linked()).toBe(true)
  })

  it('refuses a package that does not match them, though the place serves checksums that do', () => {
    const t = setup((hash) => `${hash}  ${system.name}.tar.gz\n`)
    const wrong = `${'d'.repeat(64)}  ${t.file}\n`
    const run = sh(installRun('0.2.0', wrong, { [RELEASES_ENV]: t.releases }), [], t.home, {})
    expect(run.status).toBe(1)
    expect(run.stdout).toContain('does not match its checksum; nothing was installed')
    expect(t.linked()).toBe(false)
  })

  it('refuses a package when the checksums given are empty or list nothing for it', () => {
    const t = setup((hash) => `${hash}  ${system.name}.tar.gz\n`)
    for (const given of ['', `${t.hash}  other.tar.gz\n`]) {
      const run = sh(installRun('0.2.0', given, { [RELEASES_ENV]: t.releases }), [], t.home, {})
      expect(run.status).toBe(1)
      expect(run.stdout).toContain('The checksums given list no')
      expect(t.linked()).toBe(false)
    }
  })
})

describe.skipIf(!system.supported)('the install script without checksums given', () => {
  const args = ['--no-service', '--version', '0.2.0']

  it('still downloads the checksums from the place and checks the package', () => {
    const t = setup((hash) => `${hash}  ${system.name}.tar.gz\n`)
    const run = sh(null, [INSTALL, ...args], t.home, { [RELEASES_ENV]: t.releases })
    expect(run.status).toBe(0)
    expect(t.linked()).toBe(true)
  })

  it('refuses a package that does not match the downloaded checksums', () => {
    const t = setup(() => `${'e'.repeat(64)}  ${system.name}.tar.gz\n`)
    const run = sh(null, [INSTALL, ...args], t.home, { [RELEASES_ENV]: t.releases })
    expect(run.status).toBe(1)
    expect(t.linked()).toBe(false)
  })
})
