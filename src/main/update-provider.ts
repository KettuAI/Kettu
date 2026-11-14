// electron-updater's provider for Kettu's sources: a check reads the update file and its signature
// from each source in turn and takes the first that the release key signed; downloads resolve on
// the source the updater says. Loaded with electron-updater, after the window shows.

import type {
  CancellationToken,
  Provider,
  ResolvedUpdateFileInfo,
  UpdateFileInfo,
  UpdateInfo,
} from 'electron-updater'
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider'
import { parse } from 'yaml'
import type { Logger } from './log'
import { compareVersions, errorMessage } from './update-state'
import {
  BUILT_IN_SOURCES,
  GITHUB_SOURCE,
  latestFileUrl,
  parseSourceList,
  releaseFileUrl,
  SOURCES_URL,
  SourceRun,
  SourcesFailed,
  verifySourceList,
  verifyUpdateFile,
  type SignedSourceList,
  type SourceChoice,
  type SourceList,
  type UpdateSource,
} from './update-sources'

// An update file or the source list is a few kilobytes.
const MAX_SMALL_FILE = 256 * 1024
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/

export interface FeedDeps {
  /** The version running, which no source may offer to go back from. */
  current: string
  userAgent: string
  log: Logger
  /** GitHub only, as chosen or because Kettu's services are off. */
  choice(): SourceChoice
  cachedList(): SignedSourceList | null
  saveList(list: SignedSourceList): void
  /** A check found the update on `run.current`; downloads start there. */
  checked(run: SourceRun): void
  /** Where the next download goes, which the updater moves on when a source fails. */
  downloadSource(): UpdateSource | null
}

/** Why one source could not answer a check: it was not reached, or what it gave was not usable. */
class SourceError extends Error {
  constructor(
    message: string,
    readonly reached: boolean,
  ) {
    super(message)
  }
}

function isFileInfo(value: unknown): value is UpdateFileInfo {
  if (typeof value !== 'object' || value === null) return false
  const { url, sha512 } = value as Record<string, unknown>
  return typeof url === 'string' && url.length > 0 && typeof sha512 === 'string' && !!sha512
}

/** An update file's contents, with the release version it names. */
function readUpdateInfo(file: Buffer, name: string): UpdateInfo {
  let info: unknown
  try {
    info = parse(file.toString('utf8'))
  } catch (error) {
    throw new SourceError(`${name} is not YAML: ${errorMessage(error)}`, true)
  }
  const version = (info as Partial<UpdateInfo> | null)?.version
  if (typeof version !== 'string' || !RELEASE_VERSION.test(version)) {
    throw new SourceError(`${name} names no release version`, true)
  }
  return info as UpdateInfo
}

/** A provider class on electron-updater's base, which only loads with it. */
export function sourcesProvider(
  Base: typeof Provider,
  Token: typeof CancellationToken,
  deps: FeedDeps,
) {
  const { log } = deps
  let verified: { signed: SignedSourceList; list: SourceList } | null = null

  /** The list kept from an earlier check, checked again as it was when it came. */
  function cached(): SourceList {
    const signed = deps.cachedList()
    if (!signed) return BUILT_IN_SOURCES
    if (verified?.signed.payload === signed.payload) return verified.list
    const result = verifySourceList(signed, BUILT_IN_SOURCES.serial)
    if (!result.ok) {
      log.warn(`Ignored the kept source list: ${result.reason}`)
      return BUILT_IN_SOURCES
    }
    verified = { signed, list: result.list }
    return result.list
  }

  return class SourcesProvider extends Base<UpdateInfo> {
    // electron-updater passes a custom provider its options and itself before these.
    constructor(_options: unknown, _updater: unknown, runtime: ProviderRuntimeOptions) {
      super(runtime)
    }

    // GitHub answers one range per request; the download service answers several.
    override get isUseMultipleRangeRequest(): boolean {
      return deps.downloadSource() !== GITHUB_SOURCE
    }

    // No per-install header, such as electron-updater's staging id, goes to any source.
    override get fileExtraDownloadHeaders() {
      return { 'User-Agent': deps.userAgent, Accept: '*/*' }
    }

    override async getLatestVersion(): Promise<UpdateInfo> {
      const { sources, list } = await this.sources()
      const name = `${this.getDefaultChannelName()}.yml`
      let failure: SourceError | null = null
      let stale: UpdateInfo | null = null
      for (const [index, source] of sources.entries()) {
        try {
          const info = await this.readUpdateFile(source, name, list.connectTimeoutSeconds * 1000)
          const next = sources[index + 1]
          // A signed file of an older release is real but stale, as a lagging source serves.
          if (compareVersions(info.version, deps.current) < 0) {
            if (!stale || compareVersions(info.version, stale.version) > 0) stale = info
            log.warn(
              `${source.id} offers ${info.version}, older than the running ${deps.current}` +
                (next ? `; trying ${next.id}` : ''),
            )
            continue
          }
          log.info(`Checked ${name} on ${source.id} (${source.url}): ${info.version}`)
          deps.checked(new SourceRun(sources, index, list.stallSeconds * 1000))
          return info
        } catch (error) {
          failure =
            error instanceof SourceError ? error : new SourceError(errorMessage(error), false)
          const next = sources[index + 1]
          log.warn(
            `Could not check on ${source.id}: ${failure.message}` +
              (next ? `; trying ${next.id}` : '; no source is left'),
          )
        }
      }
      // Every source that answered has only older releases, as when this one was taken back: the
      // check finds no update, which electron-updater never offers as a downgrade.
      if (stale) return stale
      const githubOnly = sources.length === 1 && sources[0] === GITHUB_SOURCE
      throw new SourcesFailed(
        failure?.message ?? 'No source to check',
        githubOnly && !failure?.reached,
      )
    }

    override resolveFiles(info: UpdateInfo): ResolvedUpdateFileInfo[] {
      const source = deps.downloadSource()
      if (!source) throw new Error('Check for updates before downloading one')
      return info.files.map((file) => ({
        url: new URL(releaseFileUrl(source, info.version, file.url)),
        info: file,
      }))
    }

    /** GitHub alone, or the latest signed list from the service, else the kept or built-in one. */
    private async sources(): Promise<{ sources: UpdateSource[]; list: SourceList }> {
      const kept = cached()
      if (deps.choice() === 'github') return { sources: [GITHUB_SOURCE], list: kept }
      let list = kept
      try {
        const body = await this.fetchSmall(SOURCES_URL, kept.connectTimeoutSeconds * 1000)
        const result = parseSourceList(body.toString('utf8'), kept.serial)
        if (result.ok) {
          list = result.list
          const saved = deps.cachedList()
          if (saved?.payload !== result.signed.payload) {
            log.info(
              `Using source list ${list.serial}: ${list.sources.map((s) => s.id).join(', ')}`,
            )
            deps.saveList(result.signed)
          }
        } else {
          log.warn(`Ignored the source list from ${SOURCES_URL}: ${result.reason}`)
        }
      } catch (error) {
        log.warn(
          `Could not read the source list: ${errorMessage(error)}; using list ${kept.serial}`,
        )
      }
      return { sources: list.sources, list }
    }

    /**
     * The latest update file, with the signature of the version it names: the latest release can
     * change between two reads, which that version's own copy of the file does not.
     */
    private async readUpdateFile(
      source: UpdateSource,
      name: string,
      timeoutMs: number,
    ): Promise<UpdateInfo> {
      let file = await this.fetchSmall(latestFileUrl(source, name), timeoutMs)
      // Read before it is verified only for the version, which names the signature to fetch.
      const { version } = readUpdateInfo(file, name)
      const signature = await this.fetchSmall(
        releaseFileUrl(source, version, `${name}.sig`),
        timeoutMs,
      )
      if (!verifyUpdateFile(file, signature)) {
        file = await this.fetchSmall(releaseFileUrl(source, version, name), timeoutMs)
        if (!verifyUpdateFile(file, signature)) {
          throw new SourceError(`${name} is not signed with Kettu's release key`, true)
        }
      }
      const info = readUpdateInfo(file, name)
      if (info.version !== version) {
        throw new SourceError(`${name} of ${version} names ${info.version}`, true)
      }
      if (!Array.isArray(info.files) || info.files.length === 0 || !info.files.every(isFileInfo)) {
        throw new SourceError(`${name} lists no files with their checksums`, true)
      }
      return info
    }

    private async fetchSmall(url: string, timeoutMs: number): Promise<Buffer> {
      const token = new Token()
      const timer = setTimeout(() => token.cancel(), timeoutMs)
      try {
        const bytes = await this.executor.downloadToBuffer(new URL(url), {
          headers: { 'User-Agent': deps.userAgent },
          cancellationToken: token,
        })
        if (bytes.length > MAX_SMALL_FILE) throw new SourceError(`${url} is too large`, true)
        return bytes
      } catch (error) {
        if (token.cancelled) {
          throw new SourceError(`no answer from ${url} within ${timeoutMs / 1000} s`, false)
        }
        throw error instanceof SourceError ? error : new SourceError(errorMessage(error), false)
      } finally {
        clearTimeout(timer)
        token.dispose()
      }
    }
  }
}
