import { describe, expect, it } from 'vitest'
import type { NpmOptions, NpmRun } from './adapter-install'
import {
  brewVersion,
  decideUpdate,
  fetchLatest,
  fetchProgramLatest,
  parseJsonVersion,
  parsePlainVersion,
} from './agent-updates'
import { ANTIGRAVITY } from './agents/antigravity'
import { CLAUDE_CODE } from './agents/claude-code'
import { GROK } from './agents/grok'
import { OMP } from './agents/omp'
import { OPENCODE } from './agents/opencode'
import type { Fetch } from './proxy-fetch'
import { TextRing } from './ring'

describe("Homebrew's version of a formula or cask", () => {
  it("reads a formula's stable version and a cask's version without its build", () => {
    const formula = { formulae: [{ name: 'opencode-v2', versions: { stable: '2.0.40' } }] }
    expect(brewVersion(JSON.stringify(formula), false)).toBe('2.0.40')
    const prefixed = { formulae: [{ name: 'omp', versions: { stable: 'v19.2.1' } }] }
    expect(brewVersion(JSON.stringify(prefixed), false)).toBe('19.2.1')
    const cask = { casks: [{ token: 'codex', version: '0.170.0,abc123' }] }
    expect(brewVersion(JSON.stringify(cask), true)).toBe('0.170.0')
  })

  it('names none for an answer without a version', () => {
    expect(brewVersion('{"formulae":[]}', false)).toBeNull()
    expect(brewVersion(JSON.stringify({ casks: [{ version: 'latest' }] }), true)).toBeNull()
    expect(brewVersion('Error: No available formula', false)).toBeNull()
  })
})

describe('official HTTP release version endpoints', () => {
  it('parses JSON and plain-text version responses with optional v prefixes', () => {
    expect(parseJsonVersion('{"version":"1.5.18"}')).toBe('1.5.18')
    expect(parseJsonVersion('{"build":{"version":"v19.2.1"}}', ['build', 'version'])).toBe('19.2.1')
    expect(parseJsonVersion('{"version":"latest"}')).toBeNull()
    expect(parseJsonVersion('not json')).toBeNull()

    expect(parsePlainVersion('  v2.1.332\n')).toBe('2.1.332')
    expect(parsePlainVersion('\n\n1.0.92\nextra line')).toBe('1.0.92')
    expect(parsePlainVersion('<html>503</html>')).toBeNull()
    expect(parsePlainVersion('')).toBeNull()
  })

  it('maps Antigravity, Grok, OMP, Claude Code, and OpenCode official endpoints and parses their payloads', () => {
    const agy = ANTIGRAVITY.installs?.versionCheck
    expect(agy?.urls('darwin', 'arm64')).toEqual([
      'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_arm64.json',
    ])
    expect(agy?.urls('win32', 'x64')).toEqual([
      'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_amd64.json',
    ])
    expect(agy?.urls('linux', 'arm64')).toEqual([
      'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_arm64.json',
    ])
    expect(agy?.urls('darwin', 'ia32')).toEqual([])
    expect(agy?.parse(JSON.stringify({ version: '1.5.18', url: 'https://example/agy.tgz' }))).toBe(
      '1.5.18',
    )

    const omp = OMP.installs?.versionCheck
    expect(omp?.urls('darwin', 'arm64')).toEqual([
      'https://build.stencil.so/api/products/omp/latest/macos-arm64?channel=stable',
    ])
    expect(omp?.urls('linux', 'x64')).toEqual([
      'https://build.stencil.so/api/products/omp/latest/linux-x86_64?channel=stable',
    ])
    expect(omp?.urls('win32', 'x64')).toEqual([])
    expect(omp?.parse(JSON.stringify({ build: { version: '19.2.1' } }))).toBe('19.2.1')

    expect(GROK.installs?.versionCheck?.urls('darwin', 'arm64')).toHaveLength(2)
    expect(GROK.installs?.versionCheck?.parse('1.0.92\n')).toBe('1.0.92')
    expect(CLAUDE_CODE.installs?.versionCheck?.parse('2.1.332\n')).toBe('2.1.332')
    expect(OPENCODE.installs?.versionCheck?.parse(JSON.stringify({ version: '2.4.2' }))).toBe(
      '2.4.2',
    )
  })

  it('fetches over HTTPS and falls back to the next URL when the primary fails', async () => {
    const requested: string[] = []
    const stubFetch: Fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      requested.push(url)
      if (url.includes('primary')) return new Response('unavailable', { status: 503 })
      return new Response('v1.0.92\n', { status: 200 })
    }) as Fetch

    const version = await fetchProgramLatest({
      name: 'Grok',
      urls: ['https://primary.example/stable', 'https://fallback.example/stable'],
      parse: parsePlainVersion,
      timeoutMs: 1_000,
      fetch: stubFetch,
    })
    expect(version).toBe('1.0.92')
    expect(requested).toEqual(['https://primary.example/stable', 'https://fallback.example/stable'])
  })

  it('rejects non-HTTPS endpoints, HTTP errors, and unreadable bodies', async () => {
    await expect(
      fetchProgramLatest({
        name: 'Test',
        urls: ['http://insecure.example/latest'],
        parse: parsePlainVersion,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow()

    const badFetch: Fetch = (async () => new Response('not-a-version', { status: 200 })) as Fetch
    await expect(
      fetchProgramLatest({
        name: 'Antigravity',
        urls: ['https://example.com/manifest.json'],
        parse: (body) => parseJsonVersion(body, ['version']),
        timeoutMs: 1_000,
        fetch: badFetch,
      }),
    ).rejects.toThrow()
  })
})

describe('decideUpdate', () => {
  it('offers newer adapter or newer CLI on the same adapter, and null when current or missing', () => {
    expect(decideUpdate(null, { version: '1.0.0', cliVersion: null })).toBeNull()
    expect(decideUpdate({ adapterVersion: '1.0.0', cliVersion: null }, null)).toBeNull()
    expect(
      decideUpdate(
        { adapterVersion: '1.0.0', cliVersion: '2.0.0' },
        { version: '1.0.0', cliVersion: '2.0.0' },
      ),
    ).toBeNull()
    expect(
      decideUpdate(
        { adapterVersion: '1.0.1', cliVersion: null },
        { version: '1.0.0', cliVersion: null },
      ),
    ).toEqual({ adapterVersion: '1.0.1', cliVersion: null })
    expect(
      decideUpdate(
        { adapterVersion: '1.0.0', cliVersion: '2.1.0' },
        { version: '1.0.0', cliVersion: '2.0.0' },
      ),
    ).toEqual({ adapterVersion: '1.0.0', cliVersion: '2.1.0' })
  })
})

describe("npm's answer for the version an install takes", () => {
  const answering = (stdout: unknown) => {
    const asked: string[][] = []
    const run = async (options: NpmOptions): Promise<NpmRun> => {
      asked.push([...options.args])
      return {
        code: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        output: new TextRing(1024),
        stdout: JSON.stringify(stdout),
      }
    }
    const options = {
      npm: '/usr/bin/npm',
      package: '@google/gemini-cli',
      cli: null,
      env: {},
      platform: 'linux' as const,
      cwd: '/home/me',
      timeoutMs: 1000,
      run,
    }
    return { asked, options }
  }

  it("carries the package's own size, read in the same view as its version", async () => {
    const latest = answering({ version: '0.66.0', 'dist.unpackedSize': 98_502_179 })
    expect(await fetchLatest(latest.options)).toEqual({
      adapterVersion: '0.66.0',
      cliVersion: null,
      unpackedSize: 98_502_179,
    })
    expect(latest.asked).toHaveLength(1)
    expect(latest.asked[0]).toContain('dist.unpackedSize')

    const ranged = answering([
      { version: '0.65.0', 'dist.unpackedSize': 1 },
      { version: '0.66.1', 'dist.unpackedSize': 2_000 },
    ])
    expect(await fetchLatest({ ...ranged.options, range: '~0.66.0' })).toEqual({
      adapterVersion: '0.66.1',
      cliVersion: null,
      unpackedSize: 2_000,
    })
    expect(ranged.asked).toHaveLength(1)
  })

  it("reads the dist-tag a vendor's install names instead of latest", async () => {
    const tagged = answering({ version: '0.1.5-prerelease.3', 'dist.unpackedSize': 7_000 })
    expect(await fetchLatest({ ...tagged.options, tag: 'prerelease' })).toEqual({
      adapterVersion: '0.1.5-prerelease.3',
      cliVersion: null,
      unpackedSize: 7_000,
    })
    expect(tagged.asked[0]?.[1]).toBe('@google/gemini-cli@prerelease')

    const plain = answering({ version: '0.66.0' })
    await fetchLatest(plain.options)
    expect(plain.asked[0]?.[1]).toBe('@google/gemini-cli')
  })

  it('refuses a tag that is not a plain name, since it reaches the command line', async () => {
    const tagged = answering({ version: '1.0.0' })
    await expect(fetchLatest({ ...tagged.options, tag: 'beta" & calc' })).rejects.toThrow()
    expect(tagged.asked).toEqual([])
  })

  it('leaves the size out when npm gives none', async () => {
    const bare = answering('0.66.0')
    expect(await fetchLatest(bare.options)).toEqual({ adapterVersion: '0.66.0', cliVersion: null })
  })
})
