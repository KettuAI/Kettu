// The icons the Kettu Marketplace stores with plugins' versions, as the host hands them to
// clients: fetched through main or the daemon from the account service alone, checked against the
// listing's SHA-256 and type and the icon rules, and given as data URLs, so no page loads a remote
// image. An icon is kept by its SHA-256, in memory and in a folder of the host's data, since the
// bytes of one hash never change.

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { MarketCall, MarketIcon, MarketResults } from '@shared/market-publish'
import type { LogFn } from '../storage'
import { checkIcon, iconDataUrl } from '../plugins/icon'

const SHA256 = /^[0-9a-f]{64}$/
/** The most data URLs held in memory; the folder keeps the rest. */
const KEPT = 200
/** How long an icon that could not be fetched is not asked for again. */
const RETRY_MS = 5 * 60_000
/** How long one that came back wrong is not asked for again, since its bytes will not change. */
const REFUSED_MS = 6 * 60 * 60_000
/** How long a list waits for its icons; one still on its way shows the next time. */
export const ICON_WAIT_MS = 8_000

export interface MarketIconsDeps {
  /** The folder icons are kept in, by SHA-256. */
  dir: string
  log: LogFn
  call(call: Extract<MarketCall, { kind: 'icon' }>): Promise<MarketResults['icon']>
  now?: () => number
}

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

export class MarketIcons {
  private readonly kept = new Map<string, string>()
  private readonly loading = new Map<string, Promise<string | null>>()
  private readonly retryAt = new Map<string, number>()
  private readonly now: () => number

  constructor(private readonly deps: MarketIconsDeps) {
    this.now = deps.now ?? Date.now
  }

  /** The icon as a data URL; null without one, or for one that did not come or did not pass. */
  async dataUrl(icon: MarketIcon | null | undefined): Promise<string | null> {
    if (!icon) return null
    const hash = icon.sha256.toLowerCase()
    if (!SHA256.test(hash)) return null
    const hit = this.kept.get(hash)
    if (hit) {
      this.kept.delete(hash)
      this.kept.set(hash, hit)
      return hit
    }
    if ((this.retryAt.get(hash) ?? 0) > this.now()) return null
    let loading = this.loading.get(hash)
    if (!loading) {
      loading = this.load(icon, hash).finally(() => this.loading.delete(hash))
      this.loading.set(hash, loading)
    }
    return loading
  }

  /** As `dataUrl`, but null once `ICON_WAIT_MS` passes; the fetch goes on and is kept. */
  waited(icon: MarketIcon | null | undefined): Promise<string | null> {
    if (!icon) return Promise.resolve(null)
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ICON_WAIT_MS)
    })
    return Promise.race([this.dataUrl(icon), late]).finally(() => clearTimeout(timer))
  }

  private async load(icon: MarketIcon, hash: string): Promise<string | null> {
    const file = path.join(this.deps.dir, hash)
    const stored = await readFile(file).catch(() => null)
    if (stored && sha256(stored) === hash && checkIcon(stored, icon.type).ok) {
      return this.keep(hash, iconDataUrl(stored, icon.type))
    }
    let answer: MarketResults['icon']
    try {
      answer = await this.deps.call({ kind: 'icon', url: icon.url })
    } catch (error) {
      this.retryAt.set(hash, this.now() + RETRY_MS)
      this.deps.log('warn', `Could not fetch a Marketplace icon: ${(error as Error).message}`)
      return null
    }
    const data = Buffer.from(answer.data, 'base64')
    const actual = sha256(data)
    const sent = answer.sha256?.toLowerCase() ?? null
    const checked = checkIcon(data, icon.type)
    const problem =
      actual !== hash || (sent !== null && sent !== hash)
        ? 'does not have the SHA-256 its listing gives'
        : checked.ok
          ? null
          : checked.reason
    if (problem) {
      this.retryAt.set(hash, this.now() + REFUSED_MS)
      this.deps.log('warn', `A Marketplace icon was not shown: it ${problem}.`)
      return null
    }
    await this.store(file, data)
    return this.keep(hash, iconDataUrl(data, icon.type))
  }

  private keep(hash: string, url: string): string {
    this.kept.set(hash, url)
    if (this.kept.size > KEPT) this.kept.delete(this.kept.keys().next().value!)
    return url
  }

  /** Writes beside the file first, so a failed write never leaves part of an icon by its hash. */
  private async store(file: string, data: Buffer): Promise<void> {
    const partial = `${file}.partial-${process.pid}`
    try {
      await mkdir(this.deps.dir, { recursive: true })
      await writeFile(partial, data)
      await rename(partial, file)
    } catch (error) {
      this.deps.log('warn', `Could not keep a Marketplace icon: ${(error as Error).message}`)
    }
  }
}
