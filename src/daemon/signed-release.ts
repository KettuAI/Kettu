// The files of a release that decide what a daemon runs, the install script and its packages'
// checksums, taken from a download place only with the release key's signature on each, which is
// checked against the same keys and with the same function as the update files'. `kettu update`
// and the desktop app's install over SSH both start from here, so no place can have a computer
// run a script of its own or take a package of its own.

import { RELEASE_KEYS, verifyUpdateFile } from '../main/update-sources'

export const INSTALL_SCRIPT = 'install.sh'
export const CHECKSUMS = 'kettu-daemon-sha256sums.txt'

/** A release's install script and its packages' checksums, both with a signature that held. */
export interface SignedRelease {
  script: string
  checksums: string
}

// The install script is a few kilobytes; a file far larger is not one the release made.
const MAX_FILE_BYTES = 256 * 1024
// These files are small; a place this slow is down.
const REQUEST_TIMEOUT_MS = 20_000

export interface SignedRequests {
  userAgent: string
  fetch: typeof fetch
  /** Stops the downloads, as when the user cancels. */
  signal?: AbortSignal
  /** The keys a signature must hold under; the release keys the app has built in by default. */
  keys?: readonly string[]
}

/** A place that did not give a file with a signature that holds; the message says why. */
export class SignedReleaseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SignedReleaseError'
  }
}

async function download(deps: SignedRequests, url: string, notFound = ''): Promise<Buffer> {
  try {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const response = await deps.fetch(url, {
      headers: { 'User-Agent': deps.userAgent },
      signal: deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout,
    })
    if (!response.ok) {
      throw new Error(`it answered ${response.status}${response.status === 404 ? notFound : ''}`)
    }
    if (!response.body) throw new Error('it answered with nothing')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_FILE_BYTES) {
        await reader.cancel()
        throw new Error('it is far larger than the release made it')
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks)
  } catch (error) {
    if (deps.signal?.aborted) throw deps.signal.reason
    const detail = (error as Error).message
    throw new SignedReleaseError(`Could not download ${url}: ${detail}`)
  }
}

/**
 * File `name` of `version` from one place, laid out as GitHub's releases, which holds only when
 * `<name>.sig` beside it is the release key's signature of it.
 */
export async function downloadSigned(
  deps: SignedRequests,
  place: string,
  version: string,
  name: string,
): Promise<Buffer> {
  const base = `${place}/download/v${encodeURIComponent(version)}/${encodeURIComponent(name)}`
  const file = await download(deps, base)
  const signature = await download(
    deps,
    `${base}.sig`,
    '; a release made before its install files were signed has none',
  )
  if (!verifyUpdateFile(name, file, signature, deps.keys ?? RELEASE_KEYS)) {
    throw new SignedReleaseError(`The signature of ${base} does not hold; it was not used`)
  }
  return file
}

/** The install script and the checksums of `version` from one place, each signed. */
export async function signedRelease(
  deps: SignedRequests,
  place: string,
  version: string,
): Promise<SignedRelease> {
  const script = await downloadSigned(deps, place, version, INSTALL_SCRIPT)
  const checksums = await downloadSigned(deps, place, version, CHECKSUMS)
  return { script: script.toString('utf8'), checksums: checksums.toString('utf8') }
}

/**
 * The checksums of `version` from the first of `places` that serves them with a signature that
 * holds. Rejects with every place's reason when none does.
 */
export async function signedChecksums(
  deps: SignedRequests,
  places: readonly string[],
  version: string,
): Promise<string> {
  const reasons: string[] = []
  for (const place of places) {
    try {
      return (await downloadSigned(deps, place, version, CHECKSUMS)).toString('utf8')
    } catch (error) {
      if (!(error instanceof SignedReleaseError)) throw error
      reasons.push(error.message)
    }
  }
  throw new SignedReleaseError(
    `No place served signed checksums for the Kettu daemon ${version}: ${reasons.join('; ')}`,
  )
}
