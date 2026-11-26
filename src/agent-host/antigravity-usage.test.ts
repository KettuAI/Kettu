// Google Antigravity's plan limits read through the user's own `agy`, which must never be left to
// open a browser sign-in.

import { describe, expect, it } from 'vitest'
import { TextRing } from './ring'
import type { ProgramOptions, ProgramRun } from './adapter-install'
import { readAntigravityUsage } from './antigravity-usage'
import { AgentRequestError } from './connection'
import credits from './vendor-usage/fixtures/agy-credits.json'
import usage from './vendor-usage/fixtures/agy-usage.json'

const NOW = Date.UTC(2026, 10, 17, 3, 45)

function finished(stdout: string, extra: Partial<ProgramRun> = {}): ProgramRun {
  return {
    code: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    output: new TextRing(64),
    stdout,
    ...extra,
  }
}

function deps(run: (options: ProgramOptions) => Promise<ProgramRun>) {
  return {
    name: 'Google Antigravity',
    program: '/home/me/.local/bin/agy',
    args: [],
    env: { HOME: '/home/me' },
    cwd: '/data/agent-reports',
    platform: 'darwin' as const,
    timeoutMs: 30_000,
    run,
  }
}

describe('reading Google Antigravity’s plan limits with agy', () => {
  it('asks agy for /usage and then /credits in JSON, in Kettu’s folder with the agent’s environment', async () => {
    const asked: ProgramOptions[] = []
    const read = await readAntigravityUsage(
      deps(async (options) => {
        asked.push(options)
        return finished(JSON.stringify(options.args.includes('/usage') ? usage : credits))
      }),
      NOW,
    )
    expect(asked.map((options) => options.args)).toEqual([
      ['-p', '/usage', '--output-format', 'json'],
      ['-p', '/credits', '--output-format', 'json'],
    ])
    expect(asked.every((options) => options.cwd === '/data/agent-reports')).toBe(true)
    expect(asked.every((options) => options.env.HOME === '/home/me')).toBe(true)
    expect(asked.every((options) => options.env.AGY_CLI_DISABLE_AUTO_UPDATE === 'true')).toBe(true)
    expect(read.limits.map((limit) => limit.window)).toEqual([
      'seven_day_gemini_models',
      'five_hour_gemini_models',
      'seven_day_claude_and_gpt_models',
      'five_hour_claude_and_gpt_models',
    ])
    expect(read.balances).toEqual([{ label: 'G1 credits', amount: 0, currency: 'credits' }])
  })

  it('stops agy at once when it starts a browser sign-in, and asks for none after it', async () => {
    const asked: string[][] = []
    const read = readAntigravityUsage(
      deps(async (options) => {
        asked.push([...options.args])
        // agy 1.5.9 signed out: it opens the sign-in page and waits for it.
        options.onOutput?.('Authentication required. Please visit the URL to log in:\n')
        expect(options.signal?.aborted).toBe(true)
        return finished('', { code: null, signal: 'SIGTERM', aborted: true })
      }),
      NOW,
    )
    await expect(read).rejects.toSatisfy(
      (error) => error instanceof AgentRequestError && error.kind === 'auth_required',
    )
    expect(asked).toHaveLength(1)
  })

  it('fails with agy’s own error, and on a reply it cannot read', async () => {
    const failed = { status: 'ERROR', error: 'quota service unavailable', num_turns: 0 }
    await expect(
      readAntigravityUsage(
        deps(async () => finished(JSON.stringify(failed), { code: 1 })),
        NOW,
      ),
    ).rejects.toThrow(/quota service unavailable/)
    await expect(
      readAntigravityUsage(
        deps(async () => finished('not json')),
        NOW,
      ),
    ).rejects.toThrow(/\/usage/)
    await expect(
      readAntigravityUsage(
        deps(async () => finished('', { timedOut: true, code: null })),
        NOW,
      ),
    ).rejects.toThrow(/30 s/)
  })

  it('keeps the limits when only the credits cannot be read', async () => {
    const read = await readAntigravityUsage(
      deps(async (options) =>
        options.args.includes('/usage')
          ? finished(JSON.stringify(usage))
          : finished('', { code: 1 }),
      ),
      NOW,
    )
    expect(read.limits).toHaveLength(4)
    expect(read.balances).toEqual([])
  })

  it('disables agy background auto-update without duplicate env keys on Windows', async () => {
    const asked: ProgramOptions[] = []
    const originalEnv: Record<string, string> = {
      USERPROFILE: 'C:\\Users\\me',
      agy_cli_disable_auto_update: 'false',
    }
    await readAntigravityUsage(
      {
        ...deps(async (options) => {
          asked.push(options)
          return finished(JSON.stringify(options.args.includes('/usage') ? usage : credits))
        }),
        platform: 'win32',
        env: originalEnv,
      },
      NOW,
    )
    expect(asked).toHaveLength(2)
    for (const options of asked) {
      const keys = Object.keys(options.env).filter(
        (k) => k.toUpperCase() === 'AGY_CLI_DISABLE_AUTO_UPDATE',
      )
      expect(keys).toEqual(['AGY_CLI_DISABLE_AUTO_UPDATE'])
      expect(options.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('true')
    }
    expect(originalEnv.agy_cli_disable_auto_update).toBe('false')
  })
})
