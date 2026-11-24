// Turning a Claude Code or Codex plugin into a Kettu plugin to publish: from a folder, or from one
// of the account's own listings of such a plugin, whose files the service still serves. What a
// conversion left out is kept for the publish card of the folder it wrote.

import path from 'node:path'
import type { MarketCall, MarketResults } from '@shared/market-publish'
import type { PluginConversion, PluginConverted } from '@shared/plugin-convert'
import { HostError } from '../errors'
import { t } from '../i18n'
import { convertFolder, convertHarnessPlugin, harnessOf, writeConverted } from '../plugins/convert'
import type { PackageFile } from '../plugins/package'
import { checkFileList, matches, modeOf } from './community'
import { MarketCallError, hostFailure } from './publish-tools'

const PARALLEL = 4

export interface PluginConverterDeps {
  /** Makes an API call through main or the daemon; throws `MarketCallError`. */
  call<K extends MarketCall['kind']>(
    call: Extract<MarketCall, { kind: K }>,
  ): Promise<MarketResults[K]>
  appVersion: string
  /** Where a listing's conversion is written, in a folder of its own for each. */
  folder: string
}

export class PluginConverter {
  /** What each written folder's conversion left out, by the folder's path. */
  private readonly made = new Map<string, PluginConversion>()

  constructor(private readonly deps: PluginConverterDeps) {}

  /** What the conversion that wrote `folder` carried and left out; null for any other folder. */
  conversionOf(folder: string): PluginConversion | null {
    return this.made.get(path.resolve(folder)) ?? null
  }

  /** Writes a Kettu plugin next to a harness plugin's folder, which stays as it is. */
  async folder(source: string): Promise<PluginConverted> {
    return this.remember(await convertFolder(source, this.deps.appVersion))
  }

  /** Writes a Kettu plugin from the files of a listing the account published as a harness plugin. */
  async listing(id: string): Promise<PluginConverted> {
    try {
      const mine = await this.deps.call({ kind: 'mine' })
      const listing = mine.listings.find((item) => item.id === id)
      const version =
        listing?.current ?? listing?.versions.find((item) => item.status === 'live')?.version
      if (!listing || listing.kind !== 'plugin' || !version) {
        throw new HostError('not_found', t('marketPublish.failure.not_found'))
      }
      const files = await this.download(id, version)
      const from = harnessOf(files)
      if (!from)
        throw new HostError(
          'invalid_params',
          t('plugins.convert.notHarness', { path: listing.slug }),
        )
      const made = convertHarnessPlugin(files, from, listing.slug, this.deps.appVersion)
      const dir = await writeConverted(path.join(this.deps.folder, made.name), made.files)
      return this.remember({ path: dir, name: made.name, conversion: made.conversion })
    } catch (error) {
      if (error instanceof MarketCallError) throw hostFailure(error.failure)
      throw error
    }
  }

  /** A version's files, each checked against the size and SHA-256 the service lists. */
  private async download(id: string, version: string): Promise<PackageFile[]> {
    const listed = await this.deps.call({ kind: 'version', id, version })
    checkFileList(listed.files)
    const files = new Array<PackageFile>(listed.files.length)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < listed.files.length) {
        const at = next++
        const file = listed.files[at]!
        const answer = await this.deps.call({ kind: 'file', id, version, path: file.path })
        const data = Buffer.from(answer.data, 'base64')
        if (!matches(file, data, answer.sha256)) {
          throw new HostError('invalid_params', t('marketCommunity.mismatch', { path: file.path }))
        }
        files[at] = { path: file.path, data, mode: modeOf(data) }
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, files.length) }, worker))
    return files
  }

  private remember(converted: PluginConverted): PluginConverted {
    this.made.set(path.resolve(converted.path), converted.conversion)
    return converted
  }
}
