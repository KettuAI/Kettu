import { describe, expect, it } from 'vitest'
import { codexLaunchEnv, type AdapterLookup } from './codex-binary'

const DIR = '/data/agents/codex/2.2.2'
const NM = `${DIR}/node_modules`
const ENTRY = `${NM}/@agentclientprotocol/codex-acp/dist/index.js`
const BINARY = `${NM}/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`

function lookup(files: string[], overrides: Partial<AdapterLookup> = {}): AdapterLookup {
  const present = new Set(files)
  return {
    dir: DIR,
    entry: ENTRY,
    platform: 'darwin',
    env: {},
    isFile: async (file) => present.has(file),
    realpath: async (file) => file,
    ...overrides,
  }
}

const npmInstall = [
  `${NM}/@openai/codex/package.json`,
  `${NM}/@openai/codex-darwin-arm64/package.json`,
  BINARY,
]

describe('codexLaunchEnv', () => {
  it('points codex-acp at the binary npm installed, with the variables codex.js sets', async () => {
    expect(await codexLaunchEnv(lookup(npmInstall))).toEqual({
      CODEX_PATH: BINARY,
      CODEX_MANAGED_BY_NPM: '1',
      CODEX_MANAGED_PACKAGE_ROOT: `${NM}/@openai/codex`,
    })
  })

  it('finds packages npm nested under the adapter, as Node.js would', async () => {
    const nested = `${NM}/@agentclientprotocol/codex-acp/node_modules/@openai`
    const binary = `${nested}/codex/node_modules/@openai/codex-darwin-x64/vendor/x86_64-apple-darwin/bin/codex`
    const env = await codexLaunchEnv(
      lookup([
        `${nested}/codex/package.json`,
        `${nested}/codex/node_modules/@openai/codex-darwin-x64/package.json`,
        binary,
      ]),
    )
    expect(env.CODEX_PATH).toBe(binary)
  })

  it('names codex.exe on Windows', async () => {
    const nm = 'C:\\Users\\a\\AppData\\Roaming\\OverBench\\agents\\codex\\2.2.2\\node_modules'
    const binary = `${nm}\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`
    const env = await codexLaunchEnv(
      lookup(
        [
          `${nm}\\@openai\\codex\\package.json`,
          `${nm}\\@openai\\codex-win32-x64\\package.json`,
          binary,
        ],
        {
          platform: 'win32',
          dir: nm.slice(0, -'\\node_modules'.length),
          entry: `${nm}\\@agentclientprotocol\\codex-acp\\dist\\index.js`,
        },
      ),
    )
    expect(env.CODEX_PATH).toBe(binary)
  })

  it('looks in its own vendor folder without the platform package, as codex.js does', async () => {
    const vendored = `${NM}/@openai/codex/vendor/aarch64-apple-darwin/bin/codex`
    const env = await codexLaunchEnv(lookup([`${NM}/@openai/codex/package.json`, vendored]))
    expect(env.CODEX_PATH).toBe(vendored)
  })

  it('leaves codex.js to it when the binary is missing', async () => {
    expect(await codexLaunchEnv(lookup(npmInstall.slice(0, 2)))).toEqual({})
    expect(await codexLaunchEnv(lookup([]))).toEqual({})
  })

  it('keeps a CODEX_PATH the user set, in any case on Windows', async () => {
    expect(
      await codexLaunchEnv(lookup(npmInstall, { env: { CODEX_PATH: '/opt/codex/bin/codex' } })),
    ).toEqual({})
    const nm = 'C:\\data\\codex\\node_modules'
    const windows = lookup(
      [
        `${nm}\\@openai\\codex\\package.json`,
        `${nm}\\@openai\\codex-win32-x64\\package.json`,
        `${nm}\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`,
      ],
      {
        platform: 'win32',
        dir: 'C:\\data\\codex',
        entry: `${nm}\\@agentclientprotocol\\codex-acp\\dist\\index.js`,
      },
    )
    expect(await codexLaunchEnv(windows)).toMatchObject({ CODEX_MANAGED_BY_NPM: '1' })
    expect(
      await codexLaunchEnv({ ...windows, env: { Codex_Path: 'C:\\tools\\codex.exe' } }),
    ).toEqual({})
  })
})
