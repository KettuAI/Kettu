// Process test: the daemon's packages served as a release serves them, from a local server laid out
// as GitHub's releases. The install script installs one into a home of its own, keeps the version
// before, refuses a package that does not match its checksum and leaves another program's kettu
// alone; kettu update moves to the latest release.

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { packageDaemon, packageName } from './package.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const INSTALL = path.join(root, 'tools', 'daemon', 'install.sh')
const LATEST = '0.0.3'
// Listed with a checksum its package does not have.
const TAMPERED = '0.0.9'

const supported = (() => {
  try {
    return packageName(process.platform, process.arch)
  } catch {
    return null
  }
})()
const name = supported ?? ''
const file = `${name}.tar.gz`

let dir = ''
let home = ''
let base = ''
let server: Server | null = null

interface Run {
  code: number
  stdout: string
  stderr: string
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        env: {
          ...process.env,
          HOME: home,
          XDG_DATA_HOME: '',
          KETTU_RELEASES_URL: base,
          KETTU_DAEMON_DATA: path.join(dir, 'data'),
          ...env,
        },
        timeout: 60_000,
      },
      (error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, stdout, stderr }),
    )
  })
}

const install = (...args: string[]) => run('/bin/sh', [INSTALL, ...args])
const kettu = (...args: string[]) => run(path.join(home, '.local', 'bin', 'kettu'), args)
const versions = () => path.join(home, '.local', 'share', 'kettu', 'versions')

/** The daemon built as it ships, reporting `version`. */
async function buildDaemon(version: string, into: string): Promise<void> {
  const manifest = path.join(root, 'package.json')
  const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>
  await build({
    configFile: path.join(root, 'vite.daemon.config.mts'),
    logLevel: 'silent',
    plugins: [
      {
        name: 'release-version',
        enforce: 'pre',
        load: (id) => (id === manifest ? JSON.stringify({ ...pkg, version }) : null),
      },
    ],
    build: { outDir: path.join(into, 'daemon') },
  })
  await mkdir(path.join(into, 'web'), { recursive: true })
  await writeFile(path.join(into, 'web', 'index.html'), '<!doctype html><title>Kettu</title>')
}

// The daemon runs on macOS and Linux only, and is packaged for Apple silicon and Linux.
const describeSupported = describe.skipIf(process.platform === 'win32' || !supported)

beforeAll(async () => {
  if (!supported) return
  // Short, so the control socket's path in the data folder fits.
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kdi-')))
  home = path.join(dir, 'home')
  await mkdir(home)
  // An unpacked Node.js release whose node runs this one, so the packages stay small.
  const node = path.join(dir, 'node')
  await mkdir(path.join(node, 'bin'), { recursive: true })
  await writeFile(path.join(node, 'bin', 'node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`)
  await chmod(path.join(node, 'bin', 'node'), 0o755)
  await writeFile(path.join(node, 'LICENSE'), 'The Node.js license')

  const release = (version: string) => path.join(dir, 'release', 'download', `v${version}`)
  for (const version of ['0.0.1', '0.0.2', LATEST]) {
    const built = path.join(dir, `build-${version}`)
    await buildDaemon(version, built)
    const { sha256 } = await packageDaemon({ out: release(version), build: built, node })
    await writeFile(
      path.join(release(version), 'kettu-daemon-sha256sums.txt'),
      `${sha256}  ${file}\n`,
    )
    await copyFile(INSTALL, path.join(release(version), 'install.sh'))
  }
  await mkdir(release(TAMPERED), { recursive: true })
  await copyFile(path.join(release(LATEST), file), path.join(release(TAMPERED), file))
  await writeFile(
    path.join(release(TAMPERED), 'kettu-daemon-sha256sums.txt'),
    `${'0'.repeat(64)}  ${file}\n`,
  )

  // GitHub's layout: latest redirects to its release page, and its downloads to that release's.
  server = createServer((request, response) => {
    const url = request.url ?? '/'
    const download = /^\/download\/(v[^/]+)\/([^/]+)$/.exec(url)
    if (url === '/latest') {
      response.writeHead(302, { location: `${base}/tag/v${LATEST}` }).end()
    } else if (url.startsWith('/latest/download/')) {
      const asset = url.slice('/latest/download/'.length)
      response.writeHead(302, { location: `${base}/download/v${LATEST}/${asset}` }).end()
    } else if (download) {
      readFile(path.join(dir, 'release', 'download', download[1]!, download[2]!)).then(
        (body) => response.writeHead(200).end(body),
        () => response.writeHead(404).end(),
      )
    } else {
      response.writeHead(404).end()
    }
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(null)))
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

describeSupported('the install script and kettu update', () => {
  it('installs a release into the home, linked from ~/.local/bin, without root', async () => {
    const installed = await install('--version', '0.0.1', '--no-service')
    expect(installed).toMatchObject({ code: 0, stderr: '' })
    const target = path.join(versions(), '0.0.1')
    expect(installed.stdout).toBe(
      `Downloading ${file}\n` +
        `Installed the Kettu daemon 0.0.1 in ${target}\n` +
        `${path.join(home, '.local', 'bin')} is not on your PATH. Add it in your shell's ` +
        'profile, such as ~/.profile:\n' +
        '  export PATH="$HOME/.local/bin:$PATH"\n' +
        'Start it with kettu run, or set up its service with kettu service install.\n',
    )
    expect(await readlink(path.join(home, '.local', 'bin', 'kettu'))).toBe(
      path.join(target, 'bin', 'kettu'),
    )
    expect(await kettu('--version')).toEqual({ code: 0, stdout: '0.0.1\n', stderr: '' })
    expect(await kettu('status')).toMatchObject({ code: 3 })
    expect((await readdir(target)).sort()).toEqual(['LICENSE', 'bin', 'daemon', 'node', 'web'])
    expect(await readFile(path.join(target, 'daemon', 'third-party-notices.txt'), 'utf8')).toMatch(
      /^node-pty \d+\.\d+\.\d+$/m,
    )

    // node-pty starts a shell from the package, its binary and helper beside its loader.
    const pty = path.join(target, 'daemon', 'node_modules', 'node-pty')
    const shell = await run(process.execPath, [
      '-e',
      `const p = require(${JSON.stringify(pty)}).spawn('/bin/sh', ['-c', 'echo from-pty'], {})
       let out = ''
       p.onData((data) => (out += data))
       p.onExit(() => console.log(out.trim()))`,
    ])
    expect(shell).toEqual({ code: 0, stdout: 'from-pty\n', stderr: '' })
  })

  it('keeps the version before when it installs another', async () => {
    expect(await install('--version', '0.0.2', '--no-service')).toMatchObject({ code: 0 })
    expect((await readdir(versions())).sort()).toEqual(['0.0.1', '0.0.2'])
    expect((await kettu('--version')).stdout).toBe('0.0.2\n')
  })

  it('updates to the latest release, leaving the one before it', async () => {
    const updated = await kettu('update')
    expect(updated).toMatchObject({ code: 0, stderr: '' })
    expect(updated.stdout).toContain('Updating the Kettu daemon from 0.0.2 to 0.0.3\n')
    expect(updated.stdout).toContain(`Installed the Kettu daemon 0.0.3 in ${versions()}/0.0.3\n`)
    expect((await readdir(versions())).sort()).toEqual(['0.0.2', '0.0.3'])
    expect((await kettu('--version')).stdout).toBe('0.0.3\n')
    expect(await kettu('update')).toEqual({
      code: 0,
      stdout: 'The Kettu daemon 0.0.3 is up to date.\n',
      stderr: '',
    })
  })

  it('installs the latest release again, with nothing named, and removes nothing', async () => {
    const again = await install('--no-service')
    expect(again).toMatchObject({ code: 0 })
    expect(again.stdout).toContain(`Installed the Kettu daemon 0.0.3 in ${versions()}/0.0.3\n`)
    expect((await readdir(versions())).sort()).toEqual(['0.0.2', '0.0.3'])
  })

  it('installs nothing from a package that does not match its checksum', async () => {
    expect(await install('--version', TAMPERED, '--no-service')).toEqual({
      code: 1,
      stdout: `Downloading ${file}\n`,
      stderr: `kettu install: ${file} does not match the release's checksum; nothing was installed\n`,
    })
    expect((await readdir(versions())).sort()).toEqual(['0.0.2', '0.0.3'])
    expect((await kettu('--version')).stdout).toBe('0.0.3\n')
  })

  it('refuses a release that does not exist', async () => {
    const missing = await install('--version', '9.9.9', '--no-service')
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain(`Could not download ${base}/download/v9.9.9/${file}\n`)
    expect((await readdir(versions())).sort()).toEqual(['0.0.2', '0.0.3'])
  })

  it("leaves another program's kettu where it is", async () => {
    const other = path.join(dir, 'other-home')
    const program = path.join(other, '.local', 'bin', 'kettu')
    await mkdir(path.dirname(program), { recursive: true })
    await writeFile(program, '#!/bin/sh\n')
    expect(await run('/bin/sh', [INSTALL, '--no-service'], { HOME: other })).toEqual({
      code: 1,
      stdout: '',
      stderr: `kettu install: ${program} is not the Kettu daemon's; move it and run this again\n`,
    })
    expect(await readFile(program, 'utf8')).toBe('#!/bin/sh\n')
  })
})
