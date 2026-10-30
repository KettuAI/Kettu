import { describe, expect, it } from 'vitest'
import type { NpmOptions, NpmRun } from './adapter-install'
import { decideUpdate, fetchLatest, type LatestOptions } from './agent-updates'
import { TextRing } from './ring'

/** An npm that answers `npm view` from a table keyed by its words before `--json`. */
function fakeNpm(answers: Record<string, Partial<NpmRun> & { json?: unknown }>) {
  const calls: NpmOptions[] = []
  const run = async (options: NpmOptions): Promise<NpmRun> => {
    calls.push(options)
    const key = options.args.slice(1, options.args.indexOf('--json')).join(' ')
    const answer = answers[key] ?? { code: 1, json: { error: { code: 'E404', summary: 'nope' } } }
    const output = new TextRing(4096)
    const stdout = answer.json === undefined ? (answer.stdout ?? '') : JSON.stringify(answer.json)
    output.push(stdout)
    return {
      code: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      ...answer,
      output: answer.output ?? output,
      stdout,
    }
  }
  return { calls, run }
}

function options(run: LatestOptions['run'], extra: Partial<LatestOptions> = {}): LatestOptions {
  return {
    npm: '/usr/local/bin/npm',
    package: '@agentclientprotocol/codex-acp',
    cli: { package: '@openai/codex', field: 'version' },
    env: { PATH: '/usr/local/bin' },
    platform: 'darwin',
    cwd: '/Users/me',
    timeoutMs: 20_000,
    ...(run ? { run } : {}),
    ...extra,
  }
}

describe('fetchLatest', () => {
  it('takes the newest CLI a fresh install of the latest adapter would get', async () => {
    const npm = fakeNpm({
      '@agentclientprotocol/codex-acp version dependencies': {
        json: { version: '2.2.2', dependencies: { zod: '^4.0.0', '@openai/codex': '^0.160.1' } },
      },
      '@openai/codex@^0.160.1 version': { json: ['0.160.1', '0.160.3', '0.160.2'] },
    })
    expect(await fetchLatest(options(npm.run))).toEqual({
      adapterVersion: '2.2.2',
      cliVersion: '0.160.3',
    })
    expect(npm.calls.map((call) => call.args)).toEqual([
      [
        'view',
        '@agentclientprotocol/codex-acp',
        'version',
        'dependencies',
        '--json',
        '--no-update-notifier',
        '--fetch-retries=0',
      ],
      [
        'view',
        '@openai/codex@^0.160.1',
        'version',
        '--json',
        '--no-update-notifier',
        '--fetch-retries=0',
      ],
    ])
    expect(npm.calls[0]).toMatchObject({ cwd: '/Users/me', timeoutMs: 20_000 })
  })

  it("reads Claude Code's version from the SDK the adapter pins", async () => {
    const npm = fakeNpm({
      '@agentclientprotocol/claude-agent-acp version dependencies': {
        json: { version: '0.94.0', dependencies: { '@anthropic-ai/claude-agent-sdk': '0.3.303' } },
      },
      '@anthropic-ai/claude-agent-sdk@0.3.303 claudeCodeVersion': { json: '2.1.303' },
    })
    const latest = await fetchLatest(
      options(npm.run, {
        package: '@agentclientprotocol/claude-agent-acp',
        cli: { package: '@anthropic-ai/claude-agent-sdk', field: 'claudeCodeVersion' },
      }),
    )
    expect(latest).toEqual({ adapterVersion: '0.94.0', cliVersion: '2.1.303' })
  })

  it('takes the version itself for a package that is the CLI, as Codex is', async () => {
    const npm = fakeNpm({
      '@openai/codex version dependencies': { json: { version: '0.167.0', dependencies: {} } },
    })
    expect(await fetchLatest(options(npm.run, { package: '@openai/codex' }))).toEqual({
      adapterVersion: '0.167.0',
      cliVersion: '0.167.0',
    })
    expect(npm.calls).toHaveLength(1)
  })

  it('names no CLI when the range is missing, odd, or could mean something to cmd.exe', async () => {
    for (const range of [undefined, 'github:openai/codex', '>=0.1 & calc', '^0.1.0 %PATH%']) {
      const npm = fakeNpm({
        '@agentclientprotocol/codex-acp version dependencies': {
          json: { version: '2.3.0', dependencies: range ? { '@openai/codex': range } : {} },
        },
      })
      expect(await fetchLatest(options(npm.run))).toEqual({
        adapterVersion: '2.3.0',
        cliVersion: null,
      })
      expect(npm.calls).toHaveLength(1)
    }
    const field = fakeNpm({
      '@agentclientprotocol/codex-acp version dependencies': { json: '2.3.0' },
    })
    expect((await fetchLatest(options(field.run))).cliVersion).toBeNull()
  })

  it('gives a reason the user can read when npm fails', async () => {
    const offline = fakeNpm({
      '@agentclientprotocol/codex-acp version dependencies': {
        code: 1,
        json: { error: { code: 'ENOTFOUND', summary: 'request to https://registry failed' } },
      },
    })
    await expect(fetchLatest(options(offline.run))).rejects.toThrow(
      'The npm registry could not be reached.',
    )
    const timedOut = fakeNpm({
      '@agentclientprotocol/codex-acp version dependencies': { code: null, timedOut: true },
    })
    await expect(fetchLatest(options(timedOut.run))).rejects.toThrow(
      'npm did not answer within 20 s.',
    )
    const missing = fakeNpm({})
    await expect(fetchLatest(options(missing.run))).rejects.toThrow('nope')
    const noVersion = fakeNpm({
      '@agentclientprotocol/codex-acp version dependencies': { json: { version: 'next' } },
    })
    await expect(fetchLatest(options(noVersion.run))).rejects.toThrow(
      'npm named no version of @agentclientprotocol/codex-acp.',
    )
  })
})

describe('fetchLatest within a range', () => {
  const SDK = '@anthropic-ai/claude-agent-sdk'
  const sdk = (run: LatestOptions['run']) =>
    options(run, {
      package: SDK,
      range: '~0.3.314',
      cli: { package: SDK, field: 'claudeCodeVersion' },
    })

  it('takes the newest version in the range, with the CLI its own field names', async () => {
    const npm = fakeNpm({
      [`${SDK}@~0.3.314 version claudeCodeVersion`]: {
        json: [
          { version: '0.3.314', claudeCodeVersion: '2.1.314' },
          { version: '0.3.320', claudeCodeVersion: '2.1.320' },
          { version: '0.3.316', claudeCodeVersion: '2.1.316' },
        ],
      },
    })
    expect(await fetchLatest(sdk(npm.run))).toEqual({
      adapterVersion: '0.3.320',
      cliVersion: '2.1.320',
    })
    expect(npm.calls.map((call) => call.args.slice(0, 4))).toEqual([
      ['view', `${SDK}@~0.3.314`, 'version', 'claudeCodeVersion'],
    ])
  })

  it('reads the one version npm prints as an object', async () => {
    const npm = fakeNpm({
      [`${SDK}@~0.3.314 version claudeCodeVersion`]: {
        json: { version: '0.3.314', claudeCodeVersion: '2.1.314' },
      },
    })
    expect(await fetchLatest(sdk(npm.run))).toEqual({
      adapterVersion: '0.3.314',
      cliVersion: '2.1.314',
    })
  })

  it('names no version when the range has none', async () => {
    const npm = fakeNpm({ [`${SDK}@~0.3.314 version claudeCodeVersion`]: { stdout: '' } })
    await expect(fetchLatest(sdk(npm.run))).rejects.toThrow(SDK)
  })
})

describe('decideUpdate', () => {
  const latest = { adapterVersion: '2.2.2', cliVersion: '0.161.0' }

  it('offers a newer adapter, and the same adapter with a newer CLI', () => {
    expect(decideUpdate(latest, { version: '2.2.1', cliVersion: '0.161.0' })).toBe(latest)
    expect(decideUpdate(latest, { version: '2.2.2', cliVersion: '0.160.1' })).toBe(latest)
    expect(decideUpdate(latest, { version: '2.2.1', cliVersion: null })).toBe(latest)
  })

  it('offers nothing when up to date, newer, unknown or not installed', () => {
    expect(decideUpdate(latest, { version: '2.2.2', cliVersion: '0.161.0' })).toBeNull()
    expect(decideUpdate(latest, { version: '2.2.2', cliVersion: '0.162.0' })).toBeNull()
    expect(decideUpdate(latest, { version: '2.3.0', cliVersion: '0.150.0' })).toBeNull()
    expect(decideUpdate(latest, { version: '2.2.2', cliVersion: null })).toBeNull()
    expect(
      decideUpdate(
        { adapterVersion: '2.2.2', cliVersion: null },
        { version: '2.2.2', cliVersion: '1.0.0' },
      ),
    ).toBeNull()
    expect(decideUpdate(latest, null)).toBeNull()
    expect(decideUpdate(null, { version: '2.2.1', cliVersion: null })).toBeNull()
  })
})
