import { describe, expect, it } from 'vitest'
import { codexBinary, npmCodexEnv } from './codex-binary'

const DIR = '/data/agents/codex/0.166.0'
const NM = `${DIR}/node_modules`
const ROOT = `${NM}/@openai/codex`
const BINARY = `${NM}/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`

const files = (paths: string[]) => {
  const present = new Set(paths)
  return async (file: string) => present.has(file)
}

const npmInstall = [`${ROOT}/package.json`, `${NM}/@openai/codex-darwin-arm64/package.json`, BINARY]

describe('codexBinary', () => {
  it('finds the binary of the platform package npm installed beside the package', async () => {
    expect(await codexBinary(ROOT, 'darwin', DIR, files(npmInstall))).toBe(BINARY)
  })

  it('finds a platform package npm nested under the package, as Node.js would', async () => {
    const nested = `${ROOT}/node_modules/@openai/codex-darwin-x64`
    const binary = `${nested}/vendor/x86_64-apple-darwin/bin/codex`
    expect(await codexBinary(ROOT, 'darwin', DIR, files([`${nested}/package.json`, binary]))).toBe(
      binary,
    )
  })

  it('names codex.exe on Windows', async () => {
    const nm = 'C:\\Users\\a\\AppData\\Roaming\\Kettu\\agents\\codex\\0.166.0\\node_modules'
    const binary = `${nm}\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`
    const present = files([`${nm}\\@openai\\codex-win32-x64\\package.json`, binary])
    expect(await codexBinary(`${nm}\\@openai\\codex`, 'win32', nm.slice(0, -13), present)).toBe(
      binary,
    )
  })

  it('looks in its own vendor folder without the platform package, as codex.js does', async () => {
    const vendored = `${ROOT}/vendor/aarch64-apple-darwin/bin/codex`
    expect(await codexBinary(ROOT, 'darwin', DIR, files([`${ROOT}/package.json`, vendored]))).toBe(
      vendored,
    )
  })

  it('finds nothing when the binary is missing, and looks no higher than the install', async () => {
    expect(await codexBinary(ROOT, 'darwin', DIR, files(npmInstall.slice(0, 2)))).toBeNull()
    const above = '/data/agents/node_modules/@openai/codex-darwin-arm64'
    const outside = files([
      `${above}/package.json`,
      `${above}/vendor/aarch64-apple-darwin/bin/codex`,
    ])
    expect(await codexBinary(ROOT, 'darwin', DIR, outside)).toBeNull()
  })
})

describe('npmCodexEnv', () => {
  it('says what codex.js says to the binary it starts for an npm install', () => {
    expect(npmCodexEnv(ROOT)).toEqual({
      CODEX_MANAGED_BY_NPM: '1',
      CODEX_MANAGED_PACKAGE_ROOT: ROOT,
    })
  })
})
