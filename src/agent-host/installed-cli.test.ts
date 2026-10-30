import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProgramOptions, ProgramRun } from './adapter-install'
import {
  CLAUDE_CLI,
  CLI_FILES,
  CliVersions,
  CODEX_CLI,
  decideCli,
  findInstalledCli,
  parseCliVersion,
  shimTarget,
  type CliFiles,
} from './installed-cli'
import { TextRing } from './ring'
import { tempFolder } from './testing/temp'

function files(contents: Record<string, string>, links: Record<string, string> = {}): CliFiles {
  return {
    isFile: async (file) => file in contents,
    realpath: async (file) => links[file] ?? file,
    readText: async (file) => {
      const text = contents[file]
      if (text === undefined) throw new Error(`ENOENT: ${file}`)
      return text
    },
  }
}

// What npm's cmd-shim writes for a native program and for a Node.js script, and pnpm's form.
const NPM_EXE_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
].join('\r\n')
const NPM_NODE_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join('\r\n')
const PNPM_SHIM = [
  '@SETLOCAL',
  '@IF EXIST "%~dp0\\node.exe" (',
  '  "%~dp0\\node.exe"  "%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  ') ELSE (',
  '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
  '  node  "%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  ')',
].join('\r\n')

const NPM_BIN = 'C:\\Users\\a\\AppData\\Roaming\\npm'

describe('shimTarget', () => {
  it('reads the program an npm or pnpm shim starts, from its own folder', () => {
    expect(shimTarget(NPM_EXE_SHIM, `${NPM_BIN}\\claude.cmd`)).toBe(
      `${NPM_BIN}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`,
    )
    expect(shimTarget(NPM_NODE_SHIM, `${NPM_BIN}\\codex.cmd`)).toBe(
      `${NPM_BIN}\\node_modules\\@openai\\codex\\bin\\codex.js`,
    )
    expect(shimTarget(PNPM_SHIM, 'C:\\pnpm\\codex.cmd')).toBe(
      'C:\\pnpm\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js',
    )
  })

  it('finds nothing in a script of the user own', () => {
    expect(shimTarget('@echo off\r\nwsl claude %*\r\n', 'C:\\bin\\claude.cmd')).toBeNull()
    expect(shimTarget('"%~dp0\\node.exe" %*', 'C:\\bin\\claude.cmd')).toBeNull()
  })
})

describe('resolving the program the adapter runs', () => {
  const codexJs = `${NPM_BIN}\\node_modules\\@openai\\codex\\bin\\codex.js`
  const codexExe = `${NPM_BIN}\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`
  const codexRoot = `${NPM_BIN}\\node_modules\\@openai\\codex`
  const windowsCodex = files({
    [`${NPM_BIN}\\codex.cmd`]: NPM_NODE_SHIM,
    [codexJs]: '',
    [`${codexRoot}\\node_modules\\@openai\\codex-win32-x64\\package.json`]: '{}',
    [codexExe]: '',
  })

  it('keeps the path as found on macOS and Linux, symbolic links included', async () => {
    const found = '/Users/a/.local/bin/claude'
    expect(await CLAUDE_CLI.resolve(found, 'darwin', files({ [found]: '' }))).toEqual({
      path: found,
      env: {},
    })
  })

  it('runs Claude Code on Windows only as an .exe, found or named by a shim', async () => {
    const exe = `${NPM_BIN}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`
    const shimmed = files({ [`${NPM_BIN}\\claude.cmd`]: NPM_EXE_SHIM, [exe]: '' })
    expect(
      await CLAUDE_CLI.resolve('C:\\Users\\a\\.local\\bin\\claude.exe', 'win32', shimmed),
    ).toEqual({
      path: 'C:\\Users\\a\\.local\\bin\\claude.exe',
      env: {},
    })
    expect(await CLAUDE_CLI.resolve(`${NPM_BIN}\\claude.cmd`, 'win32', shimmed)).toEqual({
      path: exe,
      env: {},
    })
    // A shim for a script, a missing target and a PowerShell script all need what Claude Code's
    // adapter cannot do without a shell.
    const script = files({ [`${NPM_BIN}\\claude.cmd`]: NPM_NODE_SHIM, [codexJs]: '' })
    expect(await CLAUDE_CLI.resolve(`${NPM_BIN}\\claude.cmd`, 'win32', script)).toBeNull()
    const missing = files({ [`${NPM_BIN}\\claude.cmd`]: NPM_EXE_SHIM })
    expect(await CLAUDE_CLI.resolve(`${NPM_BIN}\\claude.cmd`, 'win32', missing)).toBeNull()
    expect(await CLAUDE_CLI.resolve(`${NPM_BIN}\\claude.ps1`, 'win32', shimmed)).toBeNull()
  })

  it("runs Codex's own binary in place of npm's codex.js, with the variables codex.js sets", async () => {
    expect(await CODEX_CLI.resolve(`${NPM_BIN}\\codex.cmd`, 'win32', windowsCodex)).toEqual({
      path: codexExe,
      env: { CODEX_MANAGED_BY_NPM: '1', CODEX_MANAGED_PACKAGE_ROOT: codexRoot },
    })
    const prefix = '/Users/a/.nvm/versions/node/v22.19.0'
    const root = `${prefix}/lib/node_modules/@openai/codex`
    const binary = `${root}/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`
    const posix = files(
      {
        [`${prefix}/bin/codex`]: '',
        [`${root}/bin/codex.js`]: '',
        [`${root}/node_modules/@openai/codex-darwin-arm64/package.json`]: '{}',
        [binary]: '',
      },
      { [`${prefix}/bin/codex`]: `${root}/bin/codex.js` },
    )
    expect(await CODEX_CLI.resolve(`${prefix}/bin/codex`, 'darwin', posix)).toEqual({
      path: binary,
      env: { CODEX_MANAGED_BY_NPM: '1', CODEX_MANAGED_PACKAGE_ROOT: root },
    })
  })

  it('keeps a Codex that is a binary already, and gives up on codex.js without one', async () => {
    const brew = '/opt/homebrew/bin/codex'
    expect(await CODEX_CLI.resolve(brew, 'darwin', files({ [brew]: '' }))).toEqual({
      path: brew,
      env: {},
    })
    const noBinary = files({ [`${NPM_BIN}\\codex.cmd`]: NPM_NODE_SHIM, [codexJs]: '' })
    expect(await CODEX_CLI.resolve(`${NPM_BIN}\\codex.cmd`, 'win32', noBinary)).toBeNull()
  })

  it('follows codex.js to its own vendor folder, and runs codex.js itself off Windows', async () => {
    const root = '/usr/local/lib/node_modules/@openai/codex'
    const link = { '/usr/local/bin/codex': `${root}/bin/codex.js` }
    const vendored = `${root}/vendor/aarch64-apple-darwin/bin/codex`
    const withVendor = files({ '/usr/local/bin/codex': '', [vendored]: '' }, link)
    expect(await CODEX_CLI.resolve('/usr/local/bin/codex', 'darwin', withVendor)).toEqual({
      path: vendored,
      env: { CODEX_MANAGED_BY_NPM: '1', CODEX_MANAGED_PACKAGE_ROOT: root },
    })
    // Its shebang starts it, and its --version then says what is missing.
    const bare = files({ '/usr/local/bin/codex': '' }, link)
    expect(await CODEX_CLI.resolve('/usr/local/bin/codex', 'linux', bare)).toEqual({
      path: '/usr/local/bin/codex',
      env: {},
    })
  })

  it('reads no more of a .cmd than a shim could be', async () => {
    const limits: (number | undefined)[] = []
    const shim = files({ [`${NPM_BIN}\\claude.cmd`]: NPM_EXE_SHIM })
    const counted: CliFiles = {
      ...shim,
      readText: (file, limit) => {
        limits.push(limit)
        return shim.readText(file, limit)
      },
    }
    await CLAUDE_CLI.resolve(`${NPM_BIN}\\claude.cmd`, 'win32', counted)
    expect(limits).toEqual([64 * 1024])
  })

  it('reads at most the start of a file when asked to', async () => {
    const dir = await tempFolder('kettu-cli-files-')
    const file = path.join(dir, 'big.cmd')
    await writeFile(file, 'x'.repeat(100_000))
    expect(await CLI_FILES.readText(file, 64 * 1024)).toHaveLength(64 * 1024)
    expect(await CLI_FILES.readText(file)).toHaveLength(100_000)
  })
})

describe('the minimum an adapter names', () => {
  it("reads Claude Code's from the SDK the adapter pins", async () => {
    const sdk = path.join(
      '/data/agents/claude-code/0.94.0',
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk',
      'package.json',
    )
    const read = (manifest: unknown) =>
      CLAUDE_CLI.minimum!(
        '/data/agents/claude-code/0.94.0',
        'adapter',
        files({ [sdk]: JSON.stringify(manifest) }),
      )
    expect(await read({ claudeCodeVersion: '2.1.303' })).toBe('2.1.303')
    expect(await read({ claudeCodeVersion: 'latest' })).toBeNull()
    expect(await read({})).toBeNull()
  })

  it('names none for Codex, whose package is the CLI and whose pin is the oldest that runs', () => {
    expect(CODEX_CLI.isPackage).toBe(true)
    expect(CODEX_CLI.minimum).toBeUndefined()
  })
})

describe('parseCliVersion', () => {
  it('takes the first version in what --version prints', () => {
    expect(parseCliVersion('2.1.304 (Claude Code)\n')).toBe('2.1.304')
    expect(parseCliVersion('codex-cli 0.163.0\n')).toBe('0.163.0')
    expect(parseCliVersion('opencode v2.0.32\n')).toBe('2.0.32')
    expect(parseCliVersion('usage: claude [options]')).toBeNull()
  })
})

function run(stdout: string, code: number | null = 0, extra: Partial<ProgramRun> = {}): ProgramRun {
  return {
    code,
    signal: null,
    timedOut: false,
    aborted: false,
    output: new TextRing(1024),
    stdout,
    ...extra,
  }
}

describe('CliVersions', () => {
  it('asks once per file, and again once the file changes', async () => {
    const asked: ProgramOptions[] = []
    let size = 100
    const versions = new CliVersions({
      platform: 'darwin',
      run: async (options) => {
        asked.push(options)
        return run(`2.1.${size} (Claude Code)\n`)
      },
      stat: async () => ({ size, mtimeMs: 1 }),
    })
    expect(await versions.probe('/bin/claude', {})).toEqual({ version: '2.1.100' })
    expect(await versions.probe('/bin/claude', {})).toEqual({ version: '2.1.100' })
    expect(asked.map((o) => [o.program, o.args])).toEqual([['/bin/claude', ['--version']]])
    size = 101
    expect(await versions.probe('/bin/claude', {})).toEqual({ version: '2.1.101' })
    expect(asked).toHaveLength(2)
  })

  it('says why a program does not answer', async () => {
    const answer = (result: ProgramRun) =>
      new CliVersions({
        platform: 'darwin',
        run: async () => result,
        stat: async () => ({ size: 1, mtimeMs: 1 }),
      }).probe('/bin/codex', {})
    expect(await answer(run('', 1))).toEqual({ error: 'codex exited with code 1.' })
    expect(await answer(run('', null, { timedOut: true }))).toEqual({
      error: 'codex did not finish within 10 s.',
    })
    expect(await answer(run('codex\n'))).toEqual({ error: 'codex --version printed no version.' })
    const gone = new CliVersions({ platform: 'darwin', stat: async () => null })
    expect(await gone.probe('/bin/codex', {})).toEqual({ error: '/bin/codex was not found.' })
  })

  it('asks once more after a timeout, a failed start or a signal, and keeps none of them', async () => {
    const answers = [
      run('', null, { timedOut: true }),
      run('', null, { error: 'spawn EBUSY' }),
      run('', null, { signal: 'SIGKILL' }),
      run('', null, { timedOut: true }),
      run('', 1),
    ]
    let asked = 0
    const versions = new CliVersions({
      platform: 'darwin',
      run: async () => answers[asked++] ?? run('0.163.0\n'),
      stat: async () => ({ size: 1, mtimeMs: 1 }),
    })
    expect(await versions.probe('/bin/codex', {})).toEqual({
      error: 'codex could not be started: spawn EBUSY',
    })
    expect(asked).toBe(2)
    expect(await versions.probe('/bin/codex', {})).toEqual({
      error: 'codex did not finish within 10 s.',
    })
    expect(asked).toBe(4)
    // A non-zero exit would repeat, so it stays until the file changes.
    expect(await versions.probe('/bin/codex', {})).toEqual({ error: 'codex exited with code 1.' })
    expect(await versions.probe('/bin/codex', {})).toEqual({ error: 'codex exited with code 1.' })
    expect(asked).toBe(5)
  })

  it('keeps a program that fails the same way twice, until cleared', async () => {
    let asked = 0
    const versions = new CliVersions({
      platform: 'darwin',
      run: async () => {
        asked++
        return run('', null, { timedOut: true })
      },
      stat: async () => ({ size: 1, mtimeMs: 1 }),
    })
    const timedOut = { error: 'codex did not finish within 10 s.' }
    expect(await versions.probe('/bin/codex', {})).toEqual(timedOut)
    expect(await versions.probe('/bin/codex', {})).toEqual(timedOut)
    expect(asked).toBe(2)
    versions.clear()
    expect(await versions.probe('/bin/codex', {})).toEqual(timedOut)
    expect(asked).toBe(4)
  })

  it('answers through one slow first run', async () => {
    const answers = [run('', null, { timedOut: true })]
    const versions = new CliVersions({
      platform: 'darwin',
      run: async () => answers.shift() ?? run('2.1.304 (Claude Code)\n'),
      stat: async () => ({ size: 1, mtimeMs: 1 }),
    })
    expect(await versions.probe('/bin/claude', {})).toEqual({ version: '2.1.304' })
  })
})

describe('findInstalledCli', () => {
  const context = (env: Record<string, string>, found: string[]) => ({
    platform: 'darwin' as const,
    env: { PATH: '/usr/local/bin', ...env },
    isExecutable: async (file: string) => found.includes(file),
    files: files(Object.fromEntries(found.map((file) => [file, '']))),
    probe: async (program: string) =>
      program.includes('broken') ? { error: 'claude exited with code 1.' } : { version: '2.1.304' },
  })

  it('finds the command on PATH and asks its version', async () => {
    expect(await findInstalledCli(CLAUDE_CLI, context({}, ['/usr/local/bin/claude']))).toEqual({
      installed: {
        path: '/usr/local/bin/claude',
        version: '2.1.304',
        variable: null,
        problem: null,
      },
      env: {},
    })
    expect(await findInstalledCli(CLAUDE_CLI, context({}, []))).toBeNull()
  })

  it('leaves a program the environment names to the adapter, which reads the variable itself', async () => {
    const found = await findInstalledCli(
      CLAUDE_CLI,
      context({ CLAUDE_CODE_EXECUTABLE: '/opt/broken/claude' }, ['/usr/local/bin/claude']),
    )
    expect(found).toEqual({
      installed: {
        path: '/opt/broken/claude',
        version: null,
        variable: 'CLAUDE_CODE_EXECUTABLE',
        problem: { kind: 'failed', reason: 'claude exited with code 1.' },
      },
      env: {},
    })
  })
})

describe('decideCli', () => {
  const found = { path: '/usr/local/bin/claude', version: '2.1.304', variable: null, problem: null }
  const decide = (overrides: Partial<Parameters<typeof decideCli>[0]> = {}) =>
    decideCli({ prefer: 'installed', found, minimum: '2.1.303', failure: null, ...overrides })

  it('runs the installed program when it meets the minimum, or before the minimum is known', () => {
    expect(decide()).toEqual({ runs: 'installed', installed: found })
    expect(decide({ minimum: undefined })).toEqual({ runs: 'installed', installed: found })
  })

  it('runs the copy when none is found, or the user chose it', () => {
    expect(decide({ found: null })).toEqual({ runs: 'bundled', installed: null })
    expect(decide({ prefer: 'bundled' })).toEqual({ runs: 'bundled', installed: found })
  })

  it('runs the copy and says why when the program is too old, failed or names no minimum', () => {
    expect(decide({ minimum: '2.1.400' })).toEqual({
      runs: 'bundled',
      installed: { ...found, problem: { kind: 'too-old', minimum: '2.1.400' } },
    })
    expect(decide({ minimum: null })).toMatchObject({
      runs: 'bundled',
      installed: { problem: { kind: 'no-minimum' } },
    })
    expect(decide({ failure: { path: found.path, reason: 'Codex exited.' } })).toMatchObject({
      runs: 'bundled',
      installed: { problem: { kind: 'failed', reason: 'Codex exited.' } },
    })
    expect(decide({ failure: { path: '/other/claude', reason: 'x' } }).runs).toBe('installed')
    const unsupported = { ...found, version: null, problem: { kind: 'unsupported' as const } }
    expect(decide({ found: unsupported })).toEqual({ runs: 'bundled', installed: unsupported })
  })

  it('lets a variable in the environment decide, whatever the setting', () => {
    const named = { ...found, variable: 'CLAUDE_CODE_EXECUTABLE', version: '2.1.1' }
    expect(decide({ found: named, prefer: 'bundled' })).toEqual({
      runs: 'installed',
      installed: { ...named, problem: { kind: 'too-old', minimum: '2.1.303' } },
    })
  })
})
