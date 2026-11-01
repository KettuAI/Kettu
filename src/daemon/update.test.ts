import { describe, expect, it } from 'vitest'
import {
  installedVersions,
  isNewer,
  releaseVersion,
  update,
  UpdateError,
  type UpdateDeps,
} from './update'

const RELEASES = 'https://github.com/KettuAI/Kettu/releases'
const INSTALLED = '/home/ada/.local/share/kettu/versions/0.1.0/daemon'

function releases(files: Record<string, Response | Error>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const answer = files[String(input)]
    if (!answer) return new Response('Not Found', { status: 404 })
    if (answer instanceof Error) throw answer
    return answer
  }) as typeof fetch
}

const latest = (tag: string) =>
  new Response(null, { status: 302, headers: { location: `${RELEASES}/tag/${tag}` } })

function deps(overrides: Partial<UpdateDeps> = {}) {
  const written: string[] = []
  const installs: { script: string; args: string[] }[] = []
  const value: UpdateDeps = {
    version: '0.1.0',
    bundleDir: INSTALLED,
    releases: RELEASES,
    fetch: releases({
      [`${RELEASES}/latest`]: latest('v0.2.0'),
      [`${RELEASES}/download/v0.2.0/install.sh`]: new Response('#!/bin/sh\necho 0.2.0\n'),
    }),
    service: true,
    foreground: false,
    install: async (script, args) => {
      installs.push({ script, args })
      return 0
    },
    write: (text) => void written.push(text),
    ...overrides,
  }
  return { value, written, installs }
}

describe('installedVersions', () => {
  it('finds the versions folder of a package the install script unpacked', () => {
    expect(installedVersions(INSTALLED)).toBe('/home/ada/.local/share/kettu/versions')
  })

  it('finds none for a build run from a checkout', () => {
    expect(installedVersions('/home/ada/kettu/out/daemon')).toBeNull()
  })
})

describe('releaseVersion', () => {
  it("reads the version from the release page GitHub's latest redirects to", () => {
    expect(releaseVersion(`${RELEASES}/tag/v0.2.0`)).toBe('0.2.0')
    expect(releaseVersion('http://127.0.0.1:4567/tag/v10.20.30/')).toBe('10.20.30')
  })

  it('reads none from another page', () => {
    expect(releaseVersion(`${RELEASES}/tag/nightly`)).toBeNull()
    expect(releaseVersion('https://github.com/login')).toBeNull()
  })
})

describe('isNewer', () => {
  it.each([
    ['0.2.0', '0.1.0', true],
    ['0.10.0', '0.9.9', true],
    ['1.0.0', '0.99.0', true],
    ['0.1.0', '0.1.0', false],
    ['0.1.0', '0.2.0', false],
  ])('%s after %s: %s', (a, b, newer) => {
    expect(isNewer(a, b)).toBe(newer)
  })
})

describe('update', () => {
  it("runs the latest release's install script for that version, with the service", async () => {
    const { value, written, installs } = deps()
    expect(await update(value)).toBe(0)
    expect(installs).toEqual([{ script: '#!/bin/sh\necho 0.2.0\n', args: ['--version', '0.2.0'] }])
    expect(written).toEqual(['Updating the Kettu daemon from 0.1.0 to 0.2.0\n'])
  })

  it('leaves the service out when none is installed, and says when to restart', async () => {
    const { value, written, installs } = deps({ service: false, foreground: true })
    expect(await update(value)).toBe(0)
    expect(installs[0]!.args).toEqual(['--version', '0.2.0', '--no-service'])
    expect(written[1]).toBe(
      'The daemon running in the foreground runs 0.2.0 once you start it again.\n',
    )
  })

  it('passes on the exit code of an install that fails', async () => {
    const { value, written } = deps({ foreground: true, install: async () => 1 })
    expect(await update(value)).toBe(1)
    expect(written).toHaveLength(1)
  })

  it('says it is up to date on the latest release or a newer one', async () => {
    for (const version of ['0.2.0', '0.3.0']) {
      const { value, written, installs } = deps({ version })
      expect(await update(value)).toBe(0)
      expect(written).toEqual([`The Kettu daemon ${version} is up to date.\n`])
      expect(installs).toEqual([])
    }
  })

  it('refuses a daemon the install script did not install', async () => {
    const { value } = deps({ bundleDir: '/home/ada/kettu/out/daemon' })
    await expect(update(value)).rejects.toThrow(
      'kettu update updates a daemon the install script installed; this one runs from /home/ada/kettu/out',
    )
  })

  it('fails, installing nothing, when the releases cannot be read', async () => {
    const offline = deps({
      fetch: releases({ [`${RELEASES}/latest`]: new TypeError('fetch failed') }),
    })
    await expect(update(offline.value)).rejects.toThrow(
      new UpdateError(`Could not reach ${RELEASES}/latest: fetch failed`),
    )
    const nowhere = deps({
      fetch: releases({ [`${RELEASES}/latest`]: new Response('', { status: 200 }) }),
    })
    await expect(update(nowhere.value)).rejects.toThrow(`${RELEASES}/latest names no release`)
    const noScript = deps({ fetch: releases({ [`${RELEASES}/latest`]: latest('v0.2.0') }) })
    await expect(update(noScript.value)).rejects.toThrow(
      `Could not download ${RELEASES}/download/v0.2.0/install.sh: it answered 404`,
    )
    expect([...offline.installs, ...nowhere.installs, ...noScript.installs]).toEqual([])
  })
})
