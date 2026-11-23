// `kettu update`: moves a daemon the install script installed to the latest release by running that
// release's install script, which checks the package, moves ~/.local/bin/kettu to it and points the
// service at it. The script and the checksums it checks the package against are taken from a place
// only with the release key's signature on both.

import path from 'node:path'
import { signedRelease, type SignedRelease } from './signed-release'

/** Names the one place to download releases from, laid out as GitHub's, as for install.sh. */
export const RELEASES_ENV = 'KETTU_RELEASES_URL'
export const DOWNLOADS = 'https://download.kettu.sh'
export const RELEASES = 'https://github.com/KettuAI/Kettu/releases'
/** Holds the checksums `kettu update` verified, which the install script then takes as they are. */
export const CHECKSUMS_ENV = 'KETTU_CHECKSUMS'

// The latest release's redirect is small; a place this slow is down.
const REQUEST_TIMEOUT_MS = 20_000

/** Kettu's download service and then GitHub, or only the place `pinned` names. */
export function releaseSources(pinned: string | undefined): string[] {
  const one = pinned?.trim()
  return one ? [one] : [DOWNLOADS, RELEASES]
}

/** What `kettu update`'s requests say they are, which tells the service an update from a download. */
export function daemonUserAgent(version: string, platform: string, arch: string): string {
  return `Kettu-daemon/${version} (${platform}; ${arch})`
}

/**
 * The versions folder of a package the install script installed, which runs from
 * `<versions>/<version>/daemon`; null for a daemon run from a build, such as a checkout's out/.
 */
export function installedVersions(bundleDir: string): string | null {
  const versions = path.dirname(path.dirname(bundleDir))
  return path.basename(bundleDir) === 'daemon' && path.basename(versions) === 'versions'
    ? versions
    : null
}

/** The version of the release page an address names, as GitHub's latest release redirects. */
export function releaseVersion(location: string): string | null {
  return /\/tag\/v(\d+\.\d+\.\d+)\/?$/.exec(location)?.[1] ?? null
}

/** Whether version `a` comes after `b`, both as major.minor.patch. */
export function isNewer(a: string, b: string): boolean {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return (left[i] ?? 0) > (right[i] ?? 0)
  }
  return false
}

export class UpdateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UpdateError'
  }
}

export interface UpdateDeps {
  /** The version running. */
  version: string
  /** The folder of the running daemon's bundle. */
  bundleDir: string
  /** The places to try in order, laid out as GitHub's releases. */
  releases: string[]
  userAgent: string
  fetch: typeof fetch
  /** The keys the signatures must hold under; the release keys the app has built in by default. */
  keys?: readonly string[]
  /** Whether the daemon's service is installed, so the install sets it up again. */
  service: boolean
  /** Whether a daemon runs in the foreground, outside the service, which the update leaves be. */
  foreground: boolean
  /** Runs the verified install script with `args` and `env` and resolves to its exit code. */
  install(script: string, args: string[], env: Record<string, string>): Promise<number>
  write(text: string): void
}

type Requests = Pick<UpdateDeps, 'userAgent' | 'fetch'>
type Releases = Requests & { releases: string }

function request(deps: Requests, url: string, init: RequestInit = {}): Promise<Response> {
  return deps.fetch(url, {
    ...init,
    headers: { 'User-Agent': deps.userAgent },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
}

export async function latestVersion(deps: Releases) {
  const url = `${deps.releases}/latest`
  let location: string | null
  try {
    location = (await request(deps, url, { redirect: 'manual' })).headers.get('location')
  } catch (error) {
    throw new UpdateError(`Could not reach ${url}: ${(error as Error).message}`)
  }
  const version = location ? releaseVersion(location) : null
  if (!version) throw new UpdateError(`${url} names no release`)
  return version
}

/**
 * The latest release, with its verified install script and checksums when it is newer than the one
 * running, from the first place that answers with them. A place whose latest is older than the one
 * running lags behind, so the next is asked, and a place whose files carry no signature that holds
 * is skipped as one that is down; only when every place that answered has nothing newer is there no
 * update.
 */
async function latestRelease(
  deps: UpdateDeps,
): Promise<{ version: string; release: SignedRelease | null }> {
  let failure: unknown = new UpdateError('No place to download releases from')
  let stale: string | null = null
  for (const [index, releases] of deps.releases.entries()) {
    try {
      const version = await latestVersion({ ...deps, releases })
      if (isNewer(deps.version, version)) {
        stale = version
        const next = deps.releases[index + 1]
        if (next)
          deps.write(`${releases} offers ${version}, older than ${deps.version}; trying ${next}\n`)
        continue
      }
      if (!isNewer(version, deps.version)) return { version, release: null }
      return { version, release: await signedRelease(deps, releases, version) }
    } catch (error) {
      failure = error
      const next = deps.releases[index + 1]
      if (next) deps.write(`${(error as Error).message}; trying ${next}\n`)
    }
  }
  if (stale) return { version: stale, release: null }
  throw failure
}

/** Updates to the latest release and resolves to the exit code. */
export async function update(deps: UpdateDeps): Promise<number> {
  if (!installedVersions(deps.bundleDir)) {
    throw new UpdateError(
      'kettu update updates a daemon the install script installed; this one runs from ' +
        path.dirname(deps.bundleDir),
    )
  }
  const { version: latest, release } = await latestRelease(deps)
  if (release === null) {
    deps.write(`The Kettu daemon ${deps.version} is up to date.\n`)
    return 0
  }
  deps.write(`Updating the Kettu daemon from ${deps.version} to ${latest}\n`)
  // The script tries the same places in the same order for the package alone, which it checks
  // against the checksums verified here.
  const code = await deps.install(
    release.script,
    ['--version', latest, ...(deps.service ? [] : ['--no-service'])],
    { [CHECKSUMS_ENV]: release.checksums },
  )
  if (code === 0 && deps.foreground) {
    deps.write(`The daemon running in the foreground runs ${latest} once you start it again.\n`)
  }
  return code
}
