import { describe, expect, it } from 'vitest'
import type { ProgramOptions, ProgramRun } from '../adapter-install'
import { TextRing } from '../ring'
import { installLocalPlugin, installPlugin, type ClaudeCli } from './claude-plugins'

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

  it('points the local marketplace at a new folder without removing it, which uninstalls its plugins', async () => {
    const { cli: claude, calls } = cli((args) => {
      if (args.join(' ') === 'plugin marketplace list --json') {
        return run(
          '[{"name":"kettu-marketplace","source":"directory","path":"/old/claude-code","installLocation":"/old/claude-code"}]',
        )
      }
      if (args.join(' ') === 'plugin list --json') return run('[]')
      return run('{"outcome":"ok"}')
    })
    await installLocalPlugin(claude, '/home/.kettu/plugins/claude-code', 'hello', 'user', null)
    const changes = calls.map((call) => call.args.join(' '))
    expect(changes.some((args) => args.includes('marketplace remove'))).toBe(false)
    expect(changes).toContain('plugin marketplace add /home/.kettu/plugins/claude-code --json')
    expect(changes).toContain('plugin install hello@kettu-marketplace --scope user --json')
  })
})
