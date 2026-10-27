#!/usr/bin/env node
// @ts-check
// Checks the whole update path with two local builds: it packages the app as 0.0.900 and 0.0.901
// with a generic feed on localhost, installs and starts 0.0.900, drives the real notice over the
// Chrome DevTools Protocol, and passes once 0.0.901 has started. It uses the default data folder
// only after confirming it is absent, so it never touches an installation someone uses.
//
// On macOS, CSC_LINK and CSC_KEY_PASSWORD sign both builds with the Developer ID, which needs a
// build with MAIN_VITE_UPDATE_MODE=install, and 0.0.900 goes into /Applications. Without them the
// builds are ad-hoc signed and update in Link mode, so the check stops at the notice's Download.
//
//   pnpm build && node tools/update-e2e/run.mjs [--port 9240]
//
// On Linux CI, run it under `xvfb-run -a`.

import { spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, stopApp } from '../launch.mjs'

const root = resolve(import.meta.dirname, '..', '..')
const OLD_VERSION = '0.0.900'
const NEW_VERSION = '0.0.901'
const UPDATE_TIMEOUT_MS = 3 * 60 * 1000
const MAC_APP = '/Applications/OverBench.app'
/** @param {number} ms @returns {Promise<void>} */
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
/** @param {string} text */
const log = (text) => process.stderr.write(`[update-e2e] ${text}\n`)

/**
 * The built installer among the output folder's entries, named by the configuration's artifact
 * names: an NSIS setup, a dmg for the architecture, or an AppImage.
 * @param {string[]} files
 * @param {{ platform: NodeJS.Platform, version: string, arch: string }} target
 * @returns {string | null}
 */
export function pickInstaller(files, { platform, version, arch }) {
  if (platform === 'win32') {
    return files.find((name) => name.endsWith(`-${version}-${arch}-setup.exe`)) ?? null
  }
  if (platform === 'darwin') {
    return files.find((name) => name.endsWith(`-${version}-${arch}.dmg`)) ?? null
  }
  return files.find((name) => name.endsWith('.AppImage')) ?? null
}

/**
 * Reads app-state.json's `lastRunVersion`, or null when the file is missing, half-written or not
 * an app state.
 * @param {string} text
 * @returns {{ lastRunVersion: string | null } | null}
 */
export function readAppState(text) {
  /** @type {any} */
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || raw.version !== 1) return null
  const { lastRunVersion } = raw
  return { lastRunVersion: typeof lastRunVersion === 'string' ? lastRunVersion : null }
}

/**
 * The folder an installed app uses when it starts without `--user-data-dir`, which is where the
 * restarted version writes: Electron's appData plus the product name.
 * @param {{
 *   platform: NodeJS.Platform
 *   home: string
 *   appData: string | undefined
 *   xdgConfigHome: string | undefined
 * }} input
 * @returns {string}
 */
export function defaultDataFolder({ platform, home, appData, xdgConfigHome }) {
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'OverBench')
  }
  if (platform === 'win32') {
    return join(appData ?? join(home, 'AppData', 'Roaming'), 'OverBench')
  }
  return join(xdgConfigHome || join(home, '.config'), 'OverBench')
}

/**
 * Where the NSIS installer puts a per-user installation, which an update would overwrite too.
 * electron-builder names the folder from package.json's name, while the executable takes the
 * product name.
 * @param {{ home: string, localAppData: string | undefined }} input
 * @returns {string}
 */
export function windowsInstallFolder({ home, localAppData }) {
  return join(localAppData ?? join(home, 'AppData', 'Local'), 'Programs', 'overbench')
}

/**
 * Whether the notice's link points at the release's dmg for the architecture, which is what Link
 * mode can offer without installing anything.
 * @param {string | null} href
 * @param {{ version: string, arch: string }} target
 * @returns {boolean}
 */
export function namesDmg(href, { version, arch }) {
  if (!href) return false
  const name = safeDecode(href.slice(href.lastIndexOf('/') + 1))
  return href.includes(`/download/v${version}/`) && name === `OverBench-${version}-${arch}.dmg`
}

/** @param {string} text */
function safeDecode(text) {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/**
 * electron-builder's arguments and environment for one version: the version comes from the
 * configuration so package.json stays 0.0.0, and the feed is the local one instead of GitHub.
 * @param {{
 *   platform: NodeJS.Platform
 *   version: string
 *   output: string
 *   feedUrl: string
 *   signed: boolean
 * }} input
 * @returns {{ args: string[], env: Record<string, string> }}
 */
export function packageArgs({ platform, version, output, feedUrl, signed }) {
  const target = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : 'linux'
  return {
    args: [
      '--publish',
      'never',
      // The release's own Developer ID build; Squirrel.Mac checks the signature, never the
      // notarization, which the release run checks.
      ...(signed ? ['--config', 'electron-builder.mac-signed.yml', '-c.mac.notarize=false'] : []),
      `-c.extraMetadata.version=${version}`,
      // The platform's own publish config wins over the root one, so the GitHub release settings
      // stay out of it; overriding the root object would keep their keys.
      `-c.${target}.publish.provider=generic`,
      `-c.${target}.publish.url=${feedUrl}`,
      `-c.directories.output=${output}`,
    ],
    // An ad-hoc build must never pick an identity from the keychain; the signed one's empty
    // identity is found only by discovery, in the keychain electron-builder imports from CSC_LINK.
    env: signed ? {} : { CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  }
}

/**
 * The update mode 0.0.900 needs, which `pnpm build` fixes: only a Developer ID signed macOS build
 * can replace itself, so an ad-hoc one links to the release.
 * @param {{ platform: NodeJS.Platform, signed: boolean }} input
 * @returns {'install' | 'link'}
 */
export function expectedMode({ platform, signed }) {
  return platform === 'darwin' && !signed ? 'link' : 'install'
}

/**
 * The processes running an executable inside the folder, from `ps -axo pid=,comm=`, which on
 * macOS prints each executable's full path.
 * @param {string} output
 * @param {string} folder
 * @returns {number[]}
 */
export function processesUnder(output, folder) {
  const prefix = folder.endsWith('/') ? folder : `${folder}/`
  return output.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    return match && match[2].startsWith(prefix) ? [Number(match[1])] : []
  })
}

/**
 * Serves the newer build's output folder, which holds the update files and the installer.
 * @param {string} folder
 * @returns {Promise<{ root: string, url: string, close: () => Promise<void> }>}
 */
async function serveFeed(folder) {
  const feed = { root: folder }
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const name = safeDecode(pathname).replace(/^\/+/, '')
    const path = resolve(feed.root, name)
    if (!path.startsWith(feed.root + sep) || !existsSync(path) || !statSync(path).isFile()) {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(200, {
      'Content-Length': statSync(path).size,
      'Content-Type': 'application/octet-stream',
    })
    createReadStream(path).pipe(response)
  })
  await new Promise((done) => {
    server.listen(0, '127.0.0.1', () => done(undefined))
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    root: folder,
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise((done) => {
        // A download still running must not keep the process alive.
        server.closeAllConnections()
        server.close(() => done(undefined))
      }),
  }
}

/**
 * @param {string} version
 * @param {string} output
 * @param {string} feedUrl
 * @param {boolean} signed
 */
function packageApp(version, output, feedUrl, signed) {
  const cli = join(root, 'node_modules', 'electron-builder', 'cli.js')
  const { args, env } = packageArgs({
    platform: process.platform,
    version,
    output,
    feedUrl,
    signed,
  })
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    stdio: 'inherit',
    timeout: 15 * 60 * 1000,
    env: { ...process.env, ...env },
  })
  if (result.error) throw new Error(`Packaging ${version} failed: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`Packaging ${version} failed`)
}

/**
 * Installs the app as users do, from its dmg into /Applications, where Squirrel.Mac replaces it.
 * @param {string} dmg
 * @param {string} mount
 */
function installFromDmg(dmg, mount) {
  mkdirSync(mount, { recursive: true })
  runTool('hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-mountpoint', mount])
  try {
    runTool('ditto', [join(mount, 'OverBench.app'), MAC_APP])
  } finally {
    spawnSync('hdiutil', ['detach', mount, '-force'], { stdio: 'inherit' })
  }
}

/** @param {string} command @param {string[]} args */
function runTool(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', timeout: 5 * 60 * 1000 })
  if (result.error) throw new Error(`${command} failed: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${[command, ...args].join(' ')} failed`)
}

/** @param {string} out */
function macExecutable(out) {
  const folder = readdirSync(out).find(
    (name) => name.startsWith('mac') && existsSync(join(out, name, 'OverBench.app')),
  )
  if (!folder) throw new Error(`No OverBench.app in ${out}`)
  return join(out, folder, 'OverBench.app', 'Contents', 'MacOS', 'OverBench')
}

/**
 * Starts the 0.0.900 executable with a fresh data folder. The installer-launched version inherits
 * the Chromium log file, which is the only output the tool can see from 0.0.901, except on macOS,
 * where ShipIt starts it through launchd without the environment.
 * @param {{
 *   executable: string
 *   port: number
 *   userData: string
 *   outputLog: string
 *   chromiumLog: string
 *   env?: Record<string, string>
 * }} options
 */
function launchApp({ executable, port, userData, outputLog, chromiumLog, env = {} }) {
  const child = spawn(
    executable,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userData}`,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    {
      env: {
        ...process.env,
        // The AppImage may find no FUSE on CI; extracting still sets APPIMAGE, which the updater
        // reads, and the installer-launched version inherits both variables.
        ...(process.platform === 'linux'
          ? { APPIMAGE_EXTRACT_AND_RUN: '1', ELECTRON_DISABLE_SANDBOX: '1' }
          : {}),
        ...env,
        ELECTRON_ENABLE_LOGGING: '1',
        ELECTRON_LOG_FILE: chromiumLog,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8')
    stream?.on('data', (text) => {
      appendFileSync(outputLog, text)
      process.stderr.write(text)
    })
  }
  return child
}

/** @param {any} cdp @param {string} findBody @param {string} what */
async function click(cdp, findBody, what) {
  const point = await withTimeout(
    cdp.evaluate(`(() => {
      const el = (() => { ${findBody} })()
      if (!el) return null
      el.scrollIntoView({ block: 'nearest' })
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })()`),
    15_000,
    'the page',
  )
  if (!point) throw new Error(`Could not find ${what}`)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
  }
}

/** @param {any} cdp @param {string} expression @param {string} what @param {number} timeout */
async function waitFor(cdp, expression, what, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const answered = await withTimeout(
      cdp.evaluate(`Boolean(${expression})`),
      15_000,
      'the page',
    ).catch(() => false)
    if (answered) return
    await sleep(200)
  }
  throw new Error(`Timed out waiting for ${what}`)
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeout
 * @param {string} what
 * @returns {Promise<T>}
 */
async function withTimeout(promise, timeout, what) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer
  const expired = new Promise((_, fail) => {
    timer = setTimeout(() => fail(new Error(`Timed out waiting for ${what}`)), timeout)
  })
  try {
    return await Promise.race([promise, expired])
  } finally {
    clearTimeout(timer)
  }
}

/** @param {string} folder */
async function removeFolder(folder) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(folder, { recursive: true, force: true })
      return
    } catch {
      await sleep(250)
    }
  }
  rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
}

/** @param {string} appImage */
async function killAppImageProcesses(appImage) {
  if (process.platform !== 'linux') return
  const marker = `APPIMAGE=${appImage}`
  /** @type {number[]} */
  const pids = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const environ = readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0')
      if (environ.includes(marker)) pids.push(Number(entry))
    } catch {
      // The process ended between the listing and the read.
    }
  }
  await stopProcesses(pids)
}

/**
 * Stops every process running from the installed app, where launchd, not this tool, started
 * ShipIt and the version it installed.
 * @param {string} app
 */
async function killMacApp(app) {
  if (process.platform !== 'darwin') return
  const listed = spawnSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' })
  await stopProcesses(processesUnder(listed.stdout ?? '', app))
}

/** @param {number[]} pids */
async function stopProcesses(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Already gone.
    }
  }
  if (pids.length === 0) return
  await sleep(2000)
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

/** @param {string} installDir */
function killWindowsApp(installDir) {
  if (process.platform !== 'win32') return
  const quoted = installDir.replace(/'/g, "''")
  const script =
    'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ' +
    `$_.ExecutablePath.StartsWith('${quoted}', 'OrdinalIgnoreCase') } | ` +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'ignore',
  })
}

/** @param {string} installDir */
async function uninstallWindowsApp(installDir) {
  if (process.platform !== 'win32' || !existsSync(installDir)) return
  const uninstaller = readdirSync(installDir).find(
    (name) => name.startsWith('Uninstall') && name.endsWith('.exe'),
  )
  if (!uninstaller) return
  spawnSync(join(installDir, uninstaller), ['/S'], { stdio: 'ignore', timeout: 60_000 })
  // The uninstaller copies itself and removes the folder after returning.
  await sleep(1000)
}

/** @param {string} path */
function printLog(path) {
  if (!existsSync(path)) {
    log(`${path} was not written`)
    return
  }
  const text = readFileSync(path, 'utf8').trim()
  log(`${path}${text ? `:\n${text}` : ' is empty'}`)
}

/** @param {{ lastRunVersion: string | null } | null} state */
function stateText(state) {
  return state ? JSON.stringify(state) : 'no readable app-state.json'
}

async function main() {
  const args = process.argv.slice(2)
  const portIndex = args.indexOf('--port')
  const port = Number(portIndex === -1 ? 9240 : args[portIndex + 1])
  if (!Number.isInteger(port) || port <= 0) throw new Error('--port needs a number')

  const platform = process.platform
  const home = homedir()
  const dataFolder = defaultDataFolder({
    platform,
    home,
    appData: process.env['APPDATA'],
    xdgConfigHome: process.env['XDG_CONFIG_HOME'],
  })
  if (existsSync(dataFolder)) {
    throw new Error(
      `Refusing to run: ${dataFolder} already exists, so this is not a fresh installation`,
    )
  }
  /** @type {string | null} */
  let installDir = null
  if (platform === 'win32') {
    installDir = windowsInstallFolder({ home, localAppData: process.env['LOCALAPPDATA'] })
    if (existsSync(installDir)) throw new Error(`Refusing to run: ${installDir} already exists`)
  }
  // electron-builder signs with the Developer ID certificate it imports from CSC_LINK.
  const signed = platform === 'darwin' && Boolean(process.env['CSC_LINK'])
  if (signed && existsSync(MAC_APP)) throw new Error(`Refusing to run: ${MAC_APP} already exists`)
  if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
    throw new Error('out/main/index.js is missing; run pnpm build first')
  }

  const scratch = mkdtempSync(join(tmpdir(), 'overbench-update-'))
  const userData = join(scratch, 'user-data')
  const oldLog = join(scratch, '0.0.900.log')
  const newLog = join(scratch, '0.0.901.log')
  const appStatePath = join(dataFolder, 'app-state.json')
  mkdirSync(userData, { recursive: true })
  writeFileSync(
    join(userData, 'settings.json'),
    `${JSON.stringify({ version: 1, updates: { automatic: 'notify' } }, null, 2)}\n`,
  )

  /** @type {import('node:child_process').ChildProcess | null} */
  let running = null
  /** @type {Awaited<ReturnType<typeof connect>> | null} */
  let cdp = null
  /** @type {Awaited<ReturnType<typeof serveFeed>> | null} */
  let feed = null
  let appImage = ''
  /** @type {unknown} */
  let failure = null
  try {
    const newOutput = join(scratch, 'build-0.0.901')
    feed = await serveFeed(newOutput)
    log(`Feed at ${feed.url}`)
    if (platform === 'darwin') {
      log(signed ? 'Signing with the Developer ID in CSC_LINK' : 'No CSC_LINK: ad-hoc signing')
    }
    log(`Packaging ${OLD_VERSION}`)
    packageApp(OLD_VERSION, join(scratch, 'build-0.0.900'), feed.url, signed)
    log(`Packaged ${OLD_VERSION}`)
    log(`Packaging ${NEW_VERSION}`)
    packageApp(NEW_VERSION, newOutput, feed.url, signed)
    log(`Packaged ${NEW_VERSION}`)

    const newFiles = readdirSync(newOutput)
    const updateFile =
      platform === 'win32'
        ? 'latest.yml'
        : platform === 'darwin'
          ? 'latest-mac.yml'
          : 'latest-linux.yml'
    if (!newFiles.includes(updateFile)) {
      throw new Error(`${NEW_VERSION} has no ${updateFile} in ${newOutput}`)
    }

    const oldOutput = join(scratch, 'build-0.0.900')
    const oldFiles = readdirSync(oldOutput)
    const installer = pickInstaller(oldFiles, {
      platform,
      version: OLD_VERSION,
      arch: process.arch,
    })
    if (!installer) throw new Error(`No ${OLD_VERSION} installer in ${oldFiles.join(', ')}`)

    /** @type {string} */
    let executable
    if (platform === 'win32') {
      log(`Installing ${OLD_VERSION}`)
      const install = spawnSync(join(oldOutput, installer), ['/S'], {
        stdio: 'inherit',
        timeout: 5 * 60 * 1000,
      })
      if (install.status !== 0 || !installDir) throw new Error(`Installing ${OLD_VERSION} failed`)
      executable = join(installDir, 'OverBench.exe')
      if (!existsSync(executable)) throw new Error(`${executable} is missing after installing`)
    } else if (platform === 'linux') {
      appImage = join(scratch, 'OverBench.AppImage')
      copyFileSync(join(oldOutput, installer), appImage)
      chmodSync(appImage, 0o755)
      executable = appImage
    } else if (signed) {
      log(`Installing ${OLD_VERSION} into ${MAC_APP}`)
      installFromDmg(join(oldOutput, installer), join(scratch, 'dmg'))
      executable = join(MAC_APP, 'Contents', 'MacOS', 'OverBench')
    } else {
      executable = macExecutable(oldOutput)
    }

    log(`Starting ${OLD_VERSION}`)
    running = launchApp({
      executable,
      port,
      userData,
      outputLog: oldLog,
      chromiumLog: newLog,
      // The runtime sets this itself; naming it keeps the updater on when only the extraction
      // run is available.
      ...(platform === 'linux' ? { env: { APPIMAGE: executable } } : {}),
    })
    cdp = await connect(port)
    log(`Window answered on port ${port}`)
    await waitFor(cdp, 'window.overbench', 'the preload', 60_000)
    await waitFor(
      cdp,
      "[...document.querySelectorAll('h1')].some((h) => h.textContent.startsWith('What should'))",
      'the first window',
    )
    log(`Checking for ${NEW_VERSION}`)
    const status = await withTimeout(
      cdp.evaluate('window.overbench.updates.check()'),
      60_000,
      'the update check',
    )
    const mode = expectedMode({ platform, signed })
    if (status?.mode !== mode) {
      throw new Error(
        `${OLD_VERSION} updates in ${status?.mode} mode, not ${mode}: build it with MAIN_VITE_UPDATE_MODE=${mode}`,
      )
    }
    if (status?.state?.kind === 'error') {
      throw new Error(`The update check failed: ${status.state.message}`)
    }
    // The renderer takes the broadcast a moment later. The notice is a card in the sidebar's
    // footer, among any other notices.
    const card = '[data-sidebar=footer] [data-notice]'

    if (mode === 'link') {
      const download = `[...document.querySelectorAll('${card} a')].find((a) =>
        a.textContent.includes('Download'),
      )`
      await waitFor(cdp, download, 'the notice Download link', 30_000)
      const href = await cdp.evaluate(`${download}?.href ?? null`)
      if (!namesDmg(href, { version: NEW_VERSION, arch: process.arch })) {
        throw new Error(`The notice's Download does not name the ${process.arch} dmg: ${href}`)
      }
      log(`The notice's Download links to ${href}`)
    } else {
      const updateButton = `return [...document.querySelectorAll('${card} button')].find(
        (b) => b.textContent.trim() === 'Update',
      )`
      await waitFor(cdp, `(() => { ${updateButton} })()`, 'the notice Update button', 30_000)
      log('Clicking Update')
      await click(cdp, updateButton, 'the notice Update button')
      log(`Waiting for ${NEW_VERSION} to start`)

      const deadline = Date.now() + UPDATE_TIMEOUT_MS
      /** @type {{ lastRunVersion: string | null } | null} */
      let state = null
      while (Date.now() < deadline) {
        if (existsSync(appStatePath)) state = readAppState(readFileSync(appStatePath, 'utf8'))
        if (state?.lastRunVersion === NEW_VERSION) break
        await sleep(500)
      }
      if (state?.lastRunVersion !== NEW_VERSION) {
        throw new Error(
          `Timed out waiting for ${appStatePath} to say "${NEW_VERSION}": ${stateText(state)}`,
        )
      }
      log(`${NEW_VERSION} started and wrote ${appStatePath}`)
    }
  } catch (error) {
    failure = error
    log(`Failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (cdp) cdp.close()
    if (running) await stopApp(running)
    // A surviving helper that inherited the pipes would keep this process alive.
    running?.stdout?.destroy()
    running?.stderr?.destroy()
    if (appImage) await killAppImageProcesses(appImage)
    if (installDir) {
      killWindowsApp(installDir)
      await uninstallWindowsApp(installDir)
    }
    if (signed) {
      await killMacApp(MAC_APP)
      await removeFolder(MAC_APP)
    }
    await removeFolder(dataFolder)
    if (feed) await feed.close()
    if (failure) {
      log('0.0.900 log:')
      printLog(oldLog)
      if (signed) {
        // ShipIt starts 0.0.901 without the Chromium log file; its own logs, in a folder named
        // after the appId, say how far the install got.
        const shipIt = join(home, 'Library', 'Caches', 'com.overbench.app.ShipIt')
        log('ShipIt logs:')
        printLog(join(shipIt, 'ShipIt_stderr.log'))
        printLog(join(shipIt, 'ShipIt_stdout.log'))
      } else {
        log('0.0.901 log:')
        printLog(newLog)
      }
    }
    await removeFolder(scratch)
  }
  if (failure) process.exit(1)
  log('Updating end to end passed')
  process.exit(0)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main()
  } catch (error) {
    // The refusal happens before there is anything to clean up.
    log(`Failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
