import { describe, expect, it } from 'vitest'
import type { NpmOptions, NpmRun } from './adapter-install'
import { brewVersion, fetchLatest } from './agent-updates'
import { TextRing } from './ring'

describe("Homebrew's version of a formula or cask", () => {
  it("reads a formula's stable version and a cask's version without its build", () => {
    const formula = { formulae: [{ name: 'opencode-v2', versions: { stable: '2.0.40' } }] }
    expect(brewVersion(JSON.stringify(formula), false)).toBe('2.0.40')
    const cask = { casks: [{ token: 'codex', version: '0.170.0,abc123' }] }
    expect(brewVersion(JSON.stringify(cask), true)).toBe('0.170.0')
  })

  it('names none for an answer without a version', () => {
    expect(brewVersion('{"formulae":[]}', false)).toBeNull()
    expect(brewVersion(JSON.stringify({ casks: [{ version: 'latest' }] }), true)).toBeNull()
    expect(brewVersion('Error: No available formula', false)).toBeNull()
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
