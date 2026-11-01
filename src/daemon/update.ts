// `kettu update`: moves a daemon the install script installed to the latest release by running that
// release's install script, which checks the package, moves ~/.local/bin/kettu to it and points the
// service at it.

import path from 'node:path'

/** Names another place to download releases from, laid out as GitHub's, as for install.sh. */
export const RELEASES_ENV = 'KETTU_RELEASES_URL'
export const RELEASES = 'https://github.com/KettuAI/Kettu/releases'

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
  releases: string
  fetch: typeof fetch
  /** Whether the daemon's service is installed, so the install sets it up again. */
  service: boolean
  /** Whether a daemon runs in the foreground, outside the service, which the update leaves be. */
  foreground: boolean
  /** Runs the downloaded install script with `args` and resolves to its exit code. */
  install(script: string, args: string[]): Promise<number>
  write(text: string): void
}

export async function latestVersion(deps: Pick<UpdateDeps, 'releases' | 'fetch'>) {
  const url = `${deps.releases}/latest`
  let location: string | null
  try {
    location = (await deps.fetch(url, { redirect: 'manual' })).headers.get('location')
  } catch (error) {
    throw new UpdateError(`Could not reach ${url}: ${(error as Error).message}`)
  }
  const version = location ? releaseVersion(location) : null
  if (!version) throw new UpdateError(`${url} names no release`)
  return version
}

/** Updates to the latest release and resolves to the exit code. */
export async function update(deps: UpdateDeps): Promise<number> {
  if (!installedVersions(deps.bundleDir)) {
    throw new UpdateError(
      'kettu update updates a daemon the install script installed; this one runs from ' +
        path.dirname(deps.bundleDir),
    )
  }
  const latest = await latestVersion(deps)
  if (!isNewer(latest, deps.version)) {
    deps.write(`The Kettu daemon ${deps.version} is up to date.\n`)
    return 0
  }
  deps.write(`Updating the Kettu daemon from ${deps.version} to ${latest}\n`)
  const url = `${deps.releases}/download/v${latest}/install.sh`
  let script: string
  try {
    const response = await deps.fetch(url)
    if (!response.ok) throw new Error(`it answered ${response.status}`)
    script = await response.text()
  } catch (error) {
    throw new UpdateError(`Could not download ${url}: ${(error as Error).message}`)
  }
  const code = await deps.install(script, [
    '--version',
    latest,
    ...(deps.service ? [] : ['--no-service']),
  ])
  if (code === 0 && deps.foreground) {
    deps.write(`The daemon running in the foreground runs ${latest} once you start it again.\n`)
  }
  return code
}
