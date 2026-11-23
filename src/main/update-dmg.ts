// Link mode's update: the release's disk image for this Mac, downloaded from the same sources as
// the update check and handed to the system only once its SHA-512 matches the one the signed
// update file lists for it. Kept free of Electron so the checks can be tested.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { t, tEnglish } from './i18n'
import type { Logger } from './log'
import { GITHUB_SOURCE, releaseFileUrl, SourceRun } from './update-sources'
import { errorMessage } from './update-state'

/** The disk image an update file lists, with the base64 SHA-512 it must have. */
export interface DiskImage {
  name: string
  sha512: string
}

/** Downloads one file into `destination` and rejects when it cannot; aborting `signal` stops it. */
export type DownloadFile = (
  url: string,
  destination: string,
  options: { signal: AbortSignal; onProgress(percent: number): void },
) => Promise<void>

export interface DiskImageJob {
  /** The sources of the check, from the one that answered it. */
  run: SourceRun
  version: string
  image: DiskImage
  /** Where images are kept, a folder of the app's own. */
  folder: string
  download: DownloadFile
  /** Stops the whole download: the user's cancel. */
  signal: AbortSignal
  /** GitHub only was chosen, which sends nothing more to another source. */
  githubOnly(): boolean
  /** Hands over what stops the attempt now running, or null when none can be stopped. */
  setLeave(leave: (() => void) | null): void
  progress(percent: number): void
  log: Logger
}

// A name from the signed update file still becomes a path, so it holds nothing but a plain name.
const FILE_NAME = /^[A-Za-z0-9._-]+$/

/** The update file's .dmg for this Mac, picked by the architecture in its name, or null. */
export function diskImageFor(
  files: readonly { url: string; sha512?: string }[],
  arch: string,
): DiskImage | null {
  if (arch !== 'arm64' && arch !== 'x64') return null
  for (const { url, sha512 } of files) {
    if (sha512 && FILE_NAME.test(url) && url.endsWith(`-${arch}.dmg`)) {
      return { name: url, sha512 }
    }
  }
  return null
}

async function sha512Of(file: string): Promise<string> {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('base64')
}

/** A file whose bytes are not the ones the signed update file lists. */
class ChecksumMismatch extends Error {
  /** The message in English, for logs; `message` is in the user's language. */
  readonly log = tEnglish('updater.diskImageMismatch')

  constructor() {
    super(t('updater.diskImageMismatch'))
  }
}

/** Removes the disk images and half-written files kept earlier, except the one `keep` names. */
async function removeOthers(folder: string, keep: string): Promise<void> {
  for (const entry of await readdir(folder)) {
    if (entry !== keep && (entry.endsWith('.dmg') || entry.endsWith('.part'))) {
      await rm(join(folder, entry), { force: true })
    }
  }
}

/** Whether an image kept from an earlier click still matches; one that does not is deleted. */
async function keptMatches(file: string, sha512: string, log: Logger): Promise<boolean> {
  try {
    if ((await sha512Of(file)) === sha512) return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    log.warn(`Could not read the kept image: ${errorMessage(error)}`)
  }
  await rm(file, { force: true })
  return false
}

/**
 * Downloads the disk image from each source in turn, starting with the one that answered the
 * check: a source that cannot be reached, fails, makes no progress for the list's stall time or
 * gives bytes other than the listed ones hands the same version on to the next. Resolves with the
 * path of a file that matched; rejects once no source is left.
 */
export async function downloadDiskImage(job: DiskImageJob): Promise<string> {
  const { image, folder, log } = job
  await mkdir(folder, { recursive: true })
  await removeOthers(folder, image.name)
  const final = join(folder, image.name)
  if (await keptMatches(final, image.sha512, log)) {
    log.info(`Using the kept ${image.name}`)
    job.progress(100)
    return final
  }
  const partial = `${final}.part`
  let run = job.run
  for (;;) {
    if (job.githubOnly() && !run.githubOnly) run = SourceRun.githubOnly(run.stallMs)
    const { current: source, stallMs } = run
    const attempt = new AbortController()
    const stop = (): void => attempt.abort()
    job.signal.addEventListener('abort', stop, { once: true })
    let stalled = false
    let left = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const watch = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        stalled = true
        attempt.abort()
      }, stallMs)
    }
    job.setLeave(
      source === GITHUB_SOURCE
        ? null
        : () => {
            left = true
            attempt.abort()
          },
    )
    log.info(`Downloading ${image.name} from ${source.id}`)
    watch()
    try {
      await job.download(releaseFileUrl(source, job.version, image.name), partial, {
        signal: attempt.signal,
        // After the last byte come only the local steps.
        onProgress: (percent) => {
          if (percent >= 100) clearTimeout(timer)
          else watch()
          job.progress(percent)
        },
      })
      clearTimeout(timer)
      if ((await sha512Of(partial)) !== image.sha512) throw new ChecksumMismatch()
      await rename(partial, final)
      return final
    } catch (error) {
      await rm(partial, { force: true })
      if (job.signal.aborted) throw error
      if (left) {
        log.info(`Moving the download from ${source.id} to GitHub, now the only source`)
        continue
      }
      const reason = stalled
        ? `no progress for ${stallMs / 1000} s`
        : error instanceof ChecksumMismatch
          ? error.log
          : errorMessage(error)
      const next = run.next()
      if (!next) {
        log.warn(`Could not download from ${source.id}: ${reason}; no source is left`)
        throw stalled ? new Error(t('updater.stalled', { seconds: stallMs / 1000 })) : error
      }
      log.warn(`Could not download from ${source.id}: ${reason}; moving on to ${next.id}`)
    } finally {
      job.setLeave(null)
      clearTimeout(timer)
      job.signal.removeEventListener('abort', stop)
    }
  }
}
