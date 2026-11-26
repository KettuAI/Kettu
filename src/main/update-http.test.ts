import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { RequestOptions } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CancellationToken } from 'electron-updater'
import { GenericDifferentialDownloader } from 'electron-updater/out/differentialDownloader/GenericDifferentialDownloader'
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor'
import type { Logger } from './log'
import {
  guardUpdaterHttpExecutor,
  type GuardableUpdater,
  type UpdaterHttpExecutor,
  type UpdaterRequest,
  type UpdaterResponse,
} from './update-http'

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} }

/** Minimal Electron IncomingMessage stand-in backed by a PassThrough stream. */
class FakeIncomingMessage extends PassThrough implements UpdaterResponse {
  statusCode: number
  statusMessage: string
  headers: Record<string, string | string[]>

  constructor(
    statusCode: number,
    headers: Record<string, string | string[]> = {},
    statusMessage = 'OK',
  ) {
    super()
    this.statusCode = statusCode
    this.statusMessage = statusMessage
    this.headers = headers
  }
}

/** Minimal Electron ClientRequest stand-in that records abort/end and emits network events. */
class FakeClientRequest extends EventEmitter implements UpdaterRequest {
  aborted = false
  ended = false
  abortCount = 0
  onAbort?: () => void

  constructor(readonly options: RequestOptions) {
    super()
  }

  abort(): void {
    this.aborted = true
    this.abortCount++
    this.onAbort?.()
  }

  end(): void {
    this.ended = true
  }

  respond(response: FakeIncomingMessage): void {
    this.emit('response', response)
  }

  redirect(statusCode: number, method: string, url: string): void {
    this.emit('redirect', statusCode, method, url)
  }
}

/**
 * Real ElectronHttpExecutor with only createRequest overridden so tests exercise
 * builder-util-runtime's real doDownload / addErrorAndTimeoutHandlers / addRedirectHandlers
 * and electron-updater's real GenericDifferentialDownloader / multipleRangeDownloader.
 */
class TestElectronHttpExecutor extends ElectronHttpExecutor {
  readonly requests: FakeClientRequest[] = []

  constructor(private readonly onCreate?: (request: FakeClientRequest) => void) {
    super()
  }

  override createRequest(
    options: RequestOptions,
    callback: (response: FakeIncomingMessage) => void,
  ): Electron.ClientRequest {
    const request = new FakeClientRequest(options)
    request.on('response', callback)
    this.requests.push(request)
    this.onCreate?.(request)
    return request as unknown as Electron.ClientRequest
  }
}

function sha512Base64(data: Buffer): string {
  return createHash('sha512').update(data).digest('base64')
}

function blockHash(data: Buffer): string {
  return createHash('sha256').update(data).digest('base64')
}

describe('guardUpdaterHttpExecutor', () => {
  let workDir: string

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kettu-update-http-'))
  })

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  function makeUpdater(executor: TestElectronHttpExecutor): GuardableUpdater {
    return {
      httpExecutor: executor as unknown as UpdaterHttpExecutor,
      downloadUpdate: async (token?: CancellationToken) => {
        // Test helper overridden per test when exercising differential downloads.
        void token
        return []
      },
    }
  }

  async function buildDifferentialFixture() {
    // 4 blocks: block 0 and block 2 differ (two non-adjacent DOWNLOAD ranges -> partCount = 2 > 1),
    // which exercises electron-updater's multipleRangeDownloader multipart/byteranges path.
    const oldBlocks = [
      Buffer.from('OLD_BLOCK_000000'),
      Buffer.from('SAME_BLOCK_11111'),
      Buffer.from('OLD_BLOCK_222222'),
      Buffer.from('SAME_BLOCK_33333'),
    ]
    const newBlocks = [
      Buffer.from('NEW_BLOCK_000000'),
      Buffer.from('SAME_BLOCK_11111'),
      Buffer.from('NEW_BLOCK_222222'),
      Buffer.from('SAME_BLOCK_33333'),
    ]
    const oldBytes = Buffer.concat(oldBlocks)
    const newBytes = Buffer.concat(newBlocks)
    const oldFile = join(workDir, 'old.zip')
    const newFile = join(workDir, 'new.zip')
    await writeFile(oldFile, oldBytes)

    const oldBlockMap = {
      version: '2' as const,
      files: [
        {
          name: 'file',
          offset: 0,
          checksums: oldBlocks.map(blockHash),
          sizes: oldBlocks.map((b) => b.length),
        },
      ],
    }
    const newBlockMap = {
      version: '2' as const,
      files: [
        {
          name: 'file',
          offset: 0,
          checksums: newBlocks.map(blockHash),
          sizes: newBlocks.map((b) => b.length),
        },
      ],
    }
    return {
      oldFile,
      newFile,
      oldBlockMap,
      newBlockMap,
      fileInfo: {
        url: 'Kettu-0.1.25-arm64-mac.zip',
        size: newBytes.length,
        sha512: sha512Base64(newBytes),
      },
    }
  }

  it('catches response net::ERR_CONNECTION_RESET during multi-range differential download without throwing uncaught', async () => {
    const fixture = await buildDifferentialFixture()
    const executor = new TestElectronHttpExecutor((request) => {
      queueMicrotask(() => {
        const response = new FakeIncomingMessage(206, {
          'content-type': 'multipart/byteranges; boundary=KETTU_BOUNDARY',
        })
        request.respond(response)
        response.write('--KETTU_BOUNDARY\r\nContent-Range: bytes 0-15/64\r\n\r\nNEW_')
        // Simulate Electron's SimpleURLLoaderWrapper emitting ERR_CONNECTION_RESET mid-stream.
        response.emit('error', new Error('net::ERR_CONNECTION_RESET'))
      })
    })
    const updater = makeUpdater(executor)
    guardUpdaterHttpExecutor(updater, quiet)

    const token = new CancellationToken()
    const downloader = new GenericDifferentialDownloader(fixture.fileInfo, executor, {
      newUrl: new URL('https://download.kettu.sh/download/v0.1.25/Kettu-0.1.25-arm64-mac.zip'),
      oldFile: fixture.oldFile,
      newFile: fixture.newFile,
      isUseMultipleRangeRequest: true,
      requestHeaders: {},
      cancellationToken: token,
      logger: quiet,
    })

    await expect(downloader.download(fixture.oldBlockMap, fixture.newBlockMap)).rejects.toThrow(
      'net::ERR_CONNECTION_RESET',
    )
  })

  it('swallows response net::ERR_CONNECTION_RESET after an HTTP error status early return in doDownload', async () => {
    const executor = new TestElectronHttpExecutor((request) => {
      queueMicrotask(() => {
        const response = new FakeIncomingMessage(503, {}, 'Service Unavailable')
        request.respond(response)
        // doDownload returned early before attaching response.on('error'); a subsequent reset must
        // not escape as an uncaught exception.
        response.emit('error', new Error('net::ERR_CONNECTION_RESET'))
      })
    })
    guardUpdaterHttpExecutor(makeUpdater(executor), quiet)

    const token = new CancellationToken()
    await expect(
      executor.downloadToBuffer(new URL('https://download.kettu.sh/latest-mac.yml'), {
        cancellationToken: token,
      }),
    ).rejects.toThrow(/status 503/)
  })

  it('ignores late net::ERR_CONNECTION_RESET and net::ERR_ABORTED from a redirected request after abort', async () => {
    const executor = new TestElectronHttpExecutor((request) => {
      const index = executor.requests.length
      queueMicrotask(() => {
        if (index === 1) {
          // Simulate Electron emitting an error when ElectronHttpExecutor aborts the pre-redirect
          // request inside its redirect handler.
          request.onAbort = () => {
            request.emit('error', new Error('net::ERR_ABORTED'))
            queueMicrotask(() => {
              request.emit('error', new Error('net::ERR_CONNECTION_RESET'))
            })
          }
          request.redirect(302, 'GET', 'https://cdn.kettu.sh/release/latest-mac.yml')
          return
        }
        const response = new FakeIncomingMessage(200)
        request.respond(response)
        response.end(Buffer.from('version: 0.1.25\n'))
      })
    })
    guardUpdaterHttpExecutor(makeUpdater(executor), quiet)

    const token = new CancellationToken()
    const body = await executor.downloadToBuffer(
      new URL('https://download.kettu.sh/latest-mac.yml'),
      { cancellationToken: token },
    )
    expect(body.toString('utf8')).toBe('version: 0.1.25\n')
    expect(executor.requests).toHaveLength(2)
    expect(executor.requests[0]!.aborted).toBe(true)
  })

  it('aborts an in-flight doDownload request on stall/cancellation and swallows late reset errors', async () => {
    let activeResponse: FakeIncomingMessage | null = null
    const executor = new TestElectronHttpExecutor((request) => {
      queueMicrotask(() => {
        const response = new FakeIncomingMessage(200)
        activeResponse = response
        request.respond(response)
        response.write(Buffer.from('partial'))
      })
    })
    guardUpdaterHttpExecutor(makeUpdater(executor), quiet)

    const token = new CancellationToken()
    const download = executor.downloadToBuffer(
      new URL('https://download.kettu.sh/download/v0.1.25/update.zip'),
      { cancellationToken: token },
    )

    // Wait until response has started streaming and stalled.
    await new Promise((done) => setTimeout(done, 10))
    expect(executor.requests).toHaveLength(1)
    const request = executor.requests[0]!

    token.cancel()
    await expect(download).rejects.toThrow('cancelled')
    expect(request.aborted).toBe(true)

    // Late errors emitted after cancel/abort must never become uncaught exceptions.
    expect(() => {
      activeResponse!.emit('error', new Error('net::ERR_CONNECTION_RESET'))
      request.emit('error', new Error('net::ERR_ABORTED'))
    }).not.toThrow()
  })

  it('aborts an in-flight multi-range differential download when downloadUpdate cancellation fires', async () => {
    const fixture = await buildDifferentialFixture()
    let activeResponse: FakeIncomingMessage | null = null
    const executor = new TestElectronHttpExecutor((request) => {
      queueMicrotask(() => {
        const response = new FakeIncomingMessage(206, {
          'content-type': 'multipart/byteranges; boundary=KETTU_BOUNDARY',
        })
        activeResponse = response
        request.respond(response)
        response.write('--KETTU_BOUNDARY\r\nContent-Range: bytes 0-15/64\r\n\r\nNEW_')
        // Stall: never finish streaming.
      })
    })

    const updater: GuardableUpdater = {
      httpExecutor: executor as unknown as UpdaterHttpExecutor,
      downloadUpdate: async (token?: CancellationToken) => {
        const downloader = new GenericDifferentialDownloader(fixture.fileInfo, executor, {
          newUrl: new URL('https://download.kettu.sh/download/v0.1.25/Kettu-0.1.25-arm64-mac.zip'),
          oldFile: fixture.oldFile,
          newFile: fixture.newFile,
          isUseMultipleRangeRequest: true,
          requestHeaders: {},
          cancellationToken: token ?? new CancellationToken(),
          logger: quiet,
        })
        await downloader.download(fixture.oldBlockMap, fixture.newBlockMap)
        return [fixture.newFile]
      },
    }
    guardUpdaterHttpExecutor(updater, quiet)

    const attempt = new CancellationToken()
    const download = updater.downloadUpdate!(attempt)

    await new Promise((done) => setTimeout(done, 10))
    expect(executor.requests).toHaveLength(1)
    const request = executor.requests[0]!

    attempt.cancel()
    await expect(download).rejects.toThrow(/cancel/i)
    expect(request.aborted).toBe(true)

    // Subsequent reset/abort errors on the cancelled streams must be absorbed silently.
    expect(() => {
      activeResponse!.emit('error', new Error('net::ERR_CONNECTION_RESET'))
      request.emit('error', new Error('net::ERR_ABORTED'))
    }).not.toThrow()
  })

  it('absorbs errors emitted on a request before addErrorAndTimeoutHandlers attaches and delivers them once it does', async () => {
    const executor = new TestElectronHttpExecutor()
    guardUpdaterHttpExecutor(makeUpdater(executor), quiet)

    const request = executor.createRequest({ hostname: 'download.kettu.sh', path: '/a' }, () => {})
    expect(() => {
      request.emit('error', new Error('net::ERR_CONNECTION_RESET'))
    }).not.toThrow()

    const forwarded = await new Promise<Error>((resolve) => {
      executor.addErrorAndTimeoutHandlers(request, resolve)
    })
    expect(forwarded.message).toBe('net::ERR_CONNECTION_RESET')
  })

  it('is idempotent when called more than once on the same updater', async () => {
    const executor = new TestElectronHttpExecutor((request) => {
      queueMicrotask(() => {
        request.emit('error', new Error('net::ERR_CONNECTION_RESET'))
      })
    })
    const updater = makeUpdater(executor)
    guardUpdaterHttpExecutor(updater, quiet)
    guardUpdaterHttpExecutor(updater, quiet)

    const errors: Error[] = []
    const request = executor.createRequest({ hostname: 'download.kettu.sh', path: '/b' }, () => {})
    executor.addErrorAndTimeoutHandlers(request, (err) => errors.push(err))
    await new Promise((done) => setTimeout(done, 10))
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toBe('net::ERR_CONNECTION_RESET')
  })

  it('swallows response net::ERR_CONNECTION_RESET after a 404 early return in doApiRequest', async () => {
    const executor = new TestElectronHttpExecutor((request) => {
      queueMicrotask(() => {
        const response = new FakeIncomingMessage(404, {}, 'Not Found')
        request.respond(response)
        response.emit('error', new Error('net::ERR_CONNECTION_RESET'))
      })
    })
    guardUpdaterHttpExecutor(makeUpdater(executor), quiet)

    const token = new CancellationToken()
    await expect(
      executor.request({ hostname: 'download.kettu.sh', path: '/missing' }, token),
    ).rejects.toThrow(/404/)
  })

  it('allows fallback to a full download after differential download fails with net::ERR_CONNECTION_RESET', async () => {
    const fixture = await buildDifferentialFixture()
    let call = 0
    const executor = new TestElectronHttpExecutor((request) => {
      call++
      queueMicrotask(() => {
        if (call === 1) {
          const response = new FakeIncomingMessage(206, {
            'content-type': 'multipart/byteranges; boundary=KETTU_BOUNDARY',
          })
          request.respond(response)
          response.write('--KETTU_BOUNDARY\r\nContent-Range: bytes 0-15/64\r\n\r\nNEW_')
          response.emit('error', new Error('net::ERR_CONNECTION_RESET'))
          return
        }
        const response = new FakeIncomingMessage(200)
        request.respond(response)
        response.end(Buffer.from('full-installer-bytes'))
      })
    })
    guardUpdaterHttpExecutor(makeUpdater(executor), quiet)

    const token = new CancellationToken()
    const downloader = new GenericDifferentialDownloader(fixture.fileInfo, executor, {
      newUrl: new URL('https://download.kettu.sh/download/v0.1.25/Kettu-0.1.25-arm64-mac.zip'),
      oldFile: fixture.oldFile,
      newFile: fixture.newFile,
      isUseMultipleRangeRequest: true,
      requestHeaders: {},
      cancellationToken: token,
      logger: quiet,
    })

    let fellBack = false
    try {
      await downloader.download(fixture.oldBlockMap, fixture.newBlockMap)
    } catch {
      fellBack = true
    }
    expect(fellBack).toBe(true)

    const full = await executor.downloadToBuffer(
      new URL('https://download.kettu.sh/download/v0.1.25/Kettu-0.1.25-arm64-mac.zip'),
      { cancellationToken: token },
    )
    expect(full.toString('utf8')).toBe('full-installer-bytes')
  })

  it('aborts and rejects a request created under an already-cancelled download token', async () => {
    const executor = new TestElectronHttpExecutor()
    let rejected: Error | null = null
    const updater: GuardableUpdater = {
      httpExecutor: executor as unknown as UpdaterHttpExecutor,
      downloadUpdate: async (token?: CancellationToken) => {
        void token
        await new Promise<void>((_, reject) => {
          const request = executor.createRequest(
            { hostname: 'download.kettu.sh', path: '/range' },
            () => {},
          )
          executor.addErrorAndTimeoutHandlers(request, (err) => {
            rejected = err
            reject(err)
          })
          request.end()
        })
        return []
      },
    }
    guardUpdaterHttpExecutor(updater, quiet)

    const token = new CancellationToken()
    token.cancel()

    await expect(updater.downloadUpdate!(token)).rejects.toThrow(/cancel/i)
    expect(rejected).not.toBeNull()
    expect(executor.requests).toHaveLength(1)
    expect(executor.requests[0]!.aborted).toBe(true)
    expect(() => {
      executor.requests[0]!.emit('error', new Error('net::ERR_CONNECTION_RESET'))
    }).not.toThrow()
  })
})
