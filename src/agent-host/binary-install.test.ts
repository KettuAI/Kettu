import { describe, expect, it } from 'vitest'
import {
  globalInstallOf,
  installMethodOf,
  installPlans,
  npmPrefixOf,
  shellShimTarget,
  uninstallPlan,
  updatePlan,
  type BinaryInstalls,
  type PlanContext,
} from './binary-install'

const context: PlanContext = {
  platform: 'darwin',
  env: {},
  npm: '/usr/local/bin/npm',
  root: '/data/agents',
  agentId: 'pi',
  isExecutable: async () => false,
}

describe.each(['bash', 'sh'] as const)('the %s script route', (shell) => {
  it('quotes script arguments and preserves them on update', async () => {
    const installs = {
      script: 'https://vendor.example/install.sh',
      scriptShell: shell,
      scriptArgs: ['--non-interactive', 'two words', "it's $(false); exit 1"],
    }
    const ctx: PlanContext = {
      ...context,
      env: { PATH: '/bin' },
      isExecutable: async (file) => file === `/bin/${shell}` || file === '/bin/curl',
    }
    const [plan] = await installPlans(installs, ctx)
    const invocation = `${shell} -s -- --non-interactive 'two words' 'it'\\''s $(false); exit 1'`
    const download = 'curl -fsSL https://vendor.example/install.sh'
    expect(plan?.command).toBe(`${download} | ${invocation}`)
    expect(plan?.run).toEqual({
      program: `/bin/${shell}`,
      args: [
        '-c',
        shell === 'bash'
          ? `set -o pipefail; ${download} | ${invocation}`
          : `script="$(${download})" && printf '%s\\n' "$script" | ${invocation}`,
      ],
    })
    const update = await updatePlan(installs, 'script', { ...ctx, program: '/bin/vendor' })
    expect(update).toEqual({ command: plan?.command, run: plan?.run })
  })
})

describe('the npm route', () => {
  it('skips the package install scripts when the vendor does, on install and update', async () => {
    const installs: BinaryInstalls = { npm: 'vendor-pkg', ignoreScripts: true }
    const [plan] = await installPlans(installs, context)
    expect(plan?.id).toBe('npm')
    expect(plan?.command).toBe('npm install -g --ignore-scripts vendor-pkg')
    expect(plan?.run?.args).toContain('--ignore-scripts')

    const update = await updatePlan(installs, 'npm', { ...context, program: '/bin/pi' })
    expect(update?.command).toBe('npm install -g --ignore-scripts vendor-pkg@latest')
    expect(update?.run?.args).toContain('--ignore-scripts')
  })

  it('leaves the install scripts running when the vendor does not skip them', async () => {
    const installs: BinaryInstalls = { npm: 'vendor-pkg' }
    const [plan] = await installPlans(installs, context)
    expect(plan?.run?.args).not.toContain('--ignore-scripts')
  })

  it('updates the copy under the prefix the program was found in, whichever npm runs', async () => {
    const installs: BinaryInstalls = { npm: '@vendor/cli' }
    const update = await updatePlan(installs, 'npm', {
      ...context,
      program: '/Users/ann/.local/bin/cli',
      npmPrefix: '/Users/ann/.local',
    })
    expect(update?.command).toBe('npm install -g --prefix /Users/ann/.local @vendor/cli@latest')
    expect(update?.run?.program).toBe('/usr/local/bin/npm')
    expect(update?.run?.args.slice(0, 5)).toEqual([
      'install',
      '-g',
      '--prefix',
      '/Users/ann/.local',
      '@vendor/cli@latest',
    ])
  })

  it('installs and updates at the dist-tag the vendor documents, and removes by the bare name', async () => {
    const installs: BinaryInstalls = { npm: '@vendor/cli', npmTag: 'prerelease' }
    const [plan] = await installPlans(installs, context)
    expect(plan?.command).toBe('npm install -g @vendor/cli@prerelease')
    expect(plan?.run?.args.slice(0, 3)).toEqual(['install', '-g', '@vendor/cli@prerelease'])

    const update = await updatePlan(installs, 'npm', {
      ...context,
      program: '/Users/ann/.local/bin/cli',
      npmPrefix: '/Users/ann/.local',
    })
    expect(update?.command).toBe('npm install -g --prefix /Users/ann/.local @vendor/cli@prerelease')
    const pinned = await updatePlan(installs, 'npm', {
      ...context,
      program: '/bin/cli',
      version: '2.0.0-rc.1',
    })
    expect(pinned?.command).toBe('npm install -g @vendor/cli@2.0.0-rc.1')
    const bun = await updatePlan(installs, 'bun', { ...context, program: '/bin/cli' })
    expect(bun?.command).toBe('bun add -g @vendor/cli@prerelease')

    expect(uninstallPlan('npm', '@vendor/cli', '/Users/ann/.local', 'darwin')?.command).toBe(
      'npm uninstall -g --prefix /Users/ann/.local @vendor/cli',
    )
    expect(
      installMethodOf(installs, '/opt/homebrew/lib/node_modules/@vendor/cli/bin/cli.js', {
        platform: 'darwin',
        home: '/Users/ann',
      }),
    ).toBe('npm')
  })

  it('reads the npm prefix from where the package lives', () => {
    const pkg = '@anthropic-ai/claude-code'
    expect(
      npmPrefixOf(
        '/Users/ann/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
        pkg,
        'darwin',
      ),
    ).toBe('/Users/ann/.local')
    expect(
      npmPrefixOf(
        'C:\\Users\\Ann\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
        pkg,
        'win32',
      ),
    ).toBe('C:\\Users\\Ann\\AppData\\Roaming\\npm')
    expect(npmPrefixOf('/Users/ann/.local/share/claude/versions/2.1.326', pkg, 'darwin')).toBeNull()
  })
})

const CLAUDE = '@anthropic-ai/claude-code'

describe('the package manager that installed a program globally', () => {
  const mac = { platform: 'darwin' as const, home: '/Users/ann' }
  const windows = { platform: 'win32' as const, home: 'C:\\Users\\Ann' }
  const installs: BinaryInstalls = { npm: CLAUDE }

  it('tells pnpm, bun and yarn apart from npm by where the package lives', () => {
    const at = (file: string) => installMethodOf(installs, file, mac)
    expect(
      at(
        '/Users/ann/Library/pnpm/global/5/.pnpm/@anthropic-ai+claude-code@2.1.0/node_modules/@anthropic-ai/claude-code/cli.js',
      ),
    ).toBe('pnpm')
    expect(
      at('/Users/ann/Library/pnpm/global/v11/1f3a/node_modules/@anthropic-ai/claude-code/cli.js'),
    ).toBe('pnpm')
    expect(at('/Users/ann/.bun/install/global/node_modules/@anthropic-ai/claude-code/cli.js')).toBe(
      'bun',
    )
    expect(at('/Users/ann/.config/yarn/global/node_modules/@anthropic-ai/claude-code/cli.js')).toBe(
      'yarn',
    )
    expect(at('/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js')).toBe('npm')
  })

  it('tells them apart on Windows', () => {
    const at = (file: string) => installMethodOf(installs, file, windows)
    expect(
      at(
        'C:\\Users\\Ann\\AppData\\Local\\pnpm\\global\\5\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
      ),
    ).toBe('pnpm')
    expect(
      at(
        'C:\\Users\\Ann\\AppData\\Local\\Yarn\\Data\\global\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
      ),
    ).toBe('yarn')
    expect(
      at(
        'C:\\Users\\Ann\\.bun\\install\\global\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
      ),
    ).toBe('bun')
    expect(
      at(
        'C:\\Users\\Ann\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
      ),
    ).toBe('npm')
  })

  it('reads the folder each keeps its global packages in', () => {
    expect(
      globalInstallOf(
        '/Users/ann/Library/pnpm/global/5/.pnpm/@anthropic-ai+claude-code@2.1.0/node_modules/@anthropic-ai/claude-code/cli.js',
        CLAUDE,
        'darwin',
      ),
    ).toEqual({ manager: 'pnpm', dir: '/Users/ann/Library/pnpm/global' })
    expect(
      globalInstallOf(
        '/Users/ann/.config/yarn/global/node_modules/@anthropic-ai/claude-code/cli.js',
        CLAUDE,
        'darwin',
      ),
    ).toEqual({ manager: 'yarn', dir: '/Users/ann/.config/yarn/global' })
    expect(
      globalInstallOf(
        '/Users/ann/.bun/install/global/node_modules/@anthropic-ai/claude-code/cli.js',
        CLAUDE,
        'darwin',
      ),
    ).toEqual({ manager: 'bun', dir: null })
    expect(
      globalInstallOf(
        '/Users/ann/.local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
        CLAUDE,
        'darwin',
      ),
    ).toEqual({ manager: 'npm', dir: '/Users/ann/.local' })
    expect(
      globalInstallOf(
        'C:\\Users\\Ann\\AppData\\Local\\pnpm\\global\\5\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
        CLAUDE,
        'win32',
      ),
    ).toEqual({ manager: 'pnpm', dir: 'C:\\Users\\Ann\\AppData\\Local\\pnpm\\global' })
    // A project's own copy is no global install any tool updates.
    expect(
      globalInstallOf(
        '/Users/ann/app/node_modules/@anthropic-ai/claude-code/cli.js',
        CLAUDE,
        'darwin',
      ),
    ).toEqual({ manager: 'npm', dir: null })
    expect(globalInstallOf('/Users/ann/.local/bin/claude', CLAUDE, 'darwin')).toBeNull()
  })

  it("follows pnpm's shell shim to the package file it starts", () => {
    const shim = [
      '#!/bin/sh',
      'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
      'if [ -x "$basedir/node" ]; then',
      '  exec "$basedir/node"  "$basedir/global/5/node_modules/@anthropic-ai/claude-code/cli.js" "$@"',
      'else',
      '  exec node  "$basedir/global/5/node_modules/@anthropic-ai/claude-code/cli.js" "$@"',
      'fi',
    ].join('\n')
    expect(shellShimTarget(shim, '/Users/ann/Library/pnpm/claude')).toBe(
      '/Users/ann/Library/pnpm/global/5/node_modules/@anthropic-ai/claude-code/cli.js',
    )
    expect(shellShimTarget('#!/usr/bin/env node\nrequire("./cli")', '/usr/bin/claude')).toBeNull()
  })
})

describe('updating and removing a global package', () => {
  const tools: PlanContext = {
    ...context,
    env: { PATH: '/bin' },
    isExecutable: async (file) => ['/bin/pnpm', '/bin/bun', '/bin/yarn'].includes(file),
  }
  const installs: BinaryInstalls = { npm: '@vendor/cli', ignoreScripts: true }

  it('updates with the tool that installed it, in the folder it was found in', async () => {
    const pnpm = await updatePlan(installs, 'pnpm', {
      ...tools,
      program: '/Users/ann/Library/pnpm/cli',
      globalDir: '/Users/ann/Library/pnpm/global',
    })
    expect(pnpm).toEqual({
      command:
        'pnpm add -g --global-dir /Users/ann/Library/pnpm/global --ignore-scripts @vendor/cli@latest',
      run: {
        program: '/bin/pnpm',
        args: [
          'add',
          '-g',
          '--global-dir',
          '/Users/ann/Library/pnpm/global',
          '--ignore-scripts',
          '@vendor/cli@latest',
        ],
      },
    })
    const bun = await updatePlan(installs, 'bun', { ...tools, program: '/Users/ann/.bun/bin/cli' })
    expect(bun?.command).toBe('bun add -g --ignore-scripts @vendor/cli@latest')
    expect(bun?.run?.program).toBe('/bin/bun')
    const yarn = await updatePlan({ npm: '@vendor/cli' }, 'yarn', {
      ...tools,
      program: '/Users/ann/.yarn/bin/cli',
      globalDir: '/Users/ann/.config/yarn/global',
    })
    expect(yarn?.command).toBe(
      'yarn global add --global-folder /Users/ann/.config/yarn/global @vendor/cli@latest',
    )
    expect(yarn?.run?.program).toBe('/bin/yarn')
  })

  it('has no command to run while the tool is missing', async () => {
    const plan = await updatePlan(installs, 'pnpm', {
      ...context,
      program: '/Users/ann/Library/pnpm/cli',
      globalDir: '/Users/ann/Library/pnpm/global',
    })
    expect(plan?.run).toBeNull()
  })

  it('removes it with the same tool and folder', () => {
    expect(uninstallPlan('npm', '@vendor/cli', '/Users/ann/.local', 'darwin')).toEqual({
      command: 'npm uninstall -g --prefix /Users/ann/.local @vendor/cli',
      tool: 'npm',
      args: ['uninstall', '-g', '--prefix', '/Users/ann/.local', '@vendor/cli'],
    })
    expect(
      uninstallPlan('pnpm', '@vendor/cli', '/Users/ann/Library/pnpm/global', 'darwin'),
    ).toEqual({
      command: 'pnpm remove -g --global-dir /Users/ann/Library/pnpm/global @vendor/cli',
      tool: 'pnpm',
      args: ['remove', '-g', '--global-dir', '/Users/ann/Library/pnpm/global', '@vendor/cli'],
    })
    expect(uninstallPlan('bun', '@vendor/cli', null, 'darwin')?.command).toBe(
      'bun remove -g @vendor/cli',
    )
    expect(
      uninstallPlan('yarn', '@vendor/cli', '/Users/ann/.config/yarn/global', 'darwin')?.command,
    ).toBe('yarn global remove --global-folder /Users/ann/.config/yarn/global @vendor/cli')
    // npm's PATH prefix may hold another copy than the one found, so none is removed blind.
    expect(uninstallPlan('npm', '@vendor/cli', null, 'darwin')).toBeNull()
  })
})
