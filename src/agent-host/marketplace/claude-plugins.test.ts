import { describe, expect, it } from 'vitest'
import type { ProgramOptions, ProgramRun } from '../adapter-install'
import { TextRing } from '../ring'
import { installPlugin, type ClaudeCli } from './claude-plugins'

function run(stdout: string, code = 0): ProgramRun {
  return { code, signal: null, timedOut: false, aborted: false, output: new TextRing(1024), stdout }
}

function cli(answer: (args: readonly string[]) => ProgramRun): {
  cli: ClaudeCli
  calls: ProgramOptions[]
} {
  const calls: ProgramOptions[] = []
  return {
    calls,
    cli: {
      agentId: 'claude-code',
      program: '/opt/claude',
      env: { CLAUDE_CONFIG_DIR: '/tmp/cc' },
      platform: 'darwin',
      run: async (options) => {
        calls.push(options)
        return answer(options.args)
      },
    },
  }
}

describe("Claude Code's plugin commands", () => {
  it('never accepts a command a marketplace declares: the install fails with its message', async () => {
    const asked =
      '{"command":"install","outcome":"confirmation-required","message":"This plugin runs a command its marketplace declares; review it with claude plugin install","shownCommand":{"sha256":"ab"}}'
    const { cli: claude, calls } = cli(() => run(asked, 1))
    await expect(installPlugin(claude, 'tool@market', 'project', '/repo')).rejects.toThrow(
      /runs a command its marketplace declares/,
    )
    expect(calls[0]!.args).toEqual([
      'plugin',
      'install',
      'tool@market',
      '--scope',
      'project',
      '--json',
    ])
    expect(calls[0]!.cwd).toBe('/repo')
    expect(
      calls[0]!.args.some((arg) => arg === '-y' || arg === '--yes' || arg.startsWith('--accept')),
    ).toBe(false)
  })
})
