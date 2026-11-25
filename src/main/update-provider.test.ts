import { generateKeyPairSync, sign } from 'node:crypto'
import type { CancellationToken, Provider } from 'electron-updater'
import { describe, expect, it, vi } from 'vitest'
import type { Logger } from './log'
import { sourcesProvider } from './update-provider'
import { GITHUB_SOURCE, type SourceRun } from './update-sources'

const releaseKeys = vi.hoisted(() => [] as string[])

// The provider checks signatures with the built-in release key; these tests sign with their own.
vi.mock('./update-sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./update-sources')>()
  return {
    ...actual,
    verifyUpdateFile: (name: string, file: Uint8Array, signature: Uint8Array) =>
      actual.verifyUpdateFile(name, file, signature, releaseKeys),
  }
})

const release = generateKeyPairSync('ed25519')
releaseKeys.push(
  Buffer.from(release.publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64'),
)

const NAME = 'latest-mac.yml'
const KETTU = 'https://download.kettu.sh'
const GITHUB = GITHUB_SOURCE.url

function updateFile(version: string): Buffer {
  return Buffer.from(
    `version: ${version}\nfiles:\n  - url: Kettu-${version}.zip\n    sha512: c2hh\n`,
  )
}

function signatureOf(file: Buffer): Buffer {
  const message = Buffer.concat([Buffer.from(`${NAME}\n`), file])
  return Buffer.from(`${sign(null, message, release.privateKey).toString('base64')}\n`)
}

/** What each source serves as its latest release; a source left out answers 404 to everything. */
function served(latest: Record<string, string>): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  for (const [base, version] of Object.entries(latest)) {
    const file = updateFile(version)
    files.set(`${base}/latest/download/${NAME}`, file)
    files.set(`${base}/download/v${version}/${NAME}`, file)
    files.set(`${base}/download/v${version}/${NAME}.sig`, signatureOf(file))
  }
  return files
}

class FakeToken {
  cancelled = false
  cancel(): void {
    this.cancelled = true
  }
  dispose(): void {}
}

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} }

async function check(current: string, files: Map<string, Buffer>) {
  const asked: string[] = []
  const executor = {
    downloadToBuffer: async (url: URL): Promise<Buffer> => {
      asked.push(url.href)
      const file = files.get(url.href)
      if (file) return file
      throw Object.assign(new Error(`HttpError: 404 Not Found ${url.href}`), { statusCode: 404 })
    },
  }
  class FakeProvider {
    protected readonly executor = executor
    protected getDefaultChannelName(): string {
      return 'latest-mac'
    }
  }
  let run: SourceRun | null = null
  const Sources = sourcesProvider(
    FakeProvider as unknown as typeof Provider,
    FakeToken as unknown as typeof CancellationToken,
    {
      current,
      userAgent: 'Kettu/test',
      log: quiet,
      choice: () => 'auto',
      cachedList: () => null,
      saveList: () => {},
      checked: (r) => {
        run = r
      },
      downloadSource: () => null,
      downloader: () => {},
    },
  )
  const provider = new Sources(null, null, {} as never)
  const info = await provider.getLatestVersion()
  return { version: info.version, source: (run as SourceRun | null)?.current.id ?? null, asked }
}

describe('checking the sources in auto mode', () => {
  it('moves on to GitHub when the download service answers 404, as it does while lagging', async () => {
    const result = await check('0.1.20', served({ [GITHUB]: '0.1.23' }))
    expect(result).toMatchObject({ version: '0.1.23', source: 'github' })
  })

  it('moves on to GitHub when the download service offers an older release than this one', async () => {
    const result = await check('0.1.20', served({ [KETTU]: '0.1.19', [GITHUB]: '0.1.23' }))
    expect(result).toMatchObject({ version: '0.1.23', source: 'github' })
  })

  it('moves on to GitHub when the download service has no signature for its release', async () => {
    const files = served({ [KETTU]: '0.1.22', [GITHUB]: '0.1.23' })
    files.delete(`${KETTU}/download/v0.1.22/${NAME}.sig`)
    const result = await check('0.1.20', files)
    expect(result).toMatchObject({ version: '0.1.23', source: 'github' })
  })

  it('takes the download service release without asking GitHub', async () => {
    const result = await check('0.1.20', served({ [KETTU]: '0.1.22', [GITHUB]: '0.1.23' }))
    expect(result).toMatchObject({ version: '0.1.22', source: 'kettu' })
    expect(result.asked.some((url) => url.startsWith(GITHUB))).toBe(false)
  })
})
