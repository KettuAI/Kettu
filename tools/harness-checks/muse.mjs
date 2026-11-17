// Muse Code: the version on the vendor's stable channel, downloaded as the app downloads the
// vendor's program, checked by the SHA-256 its release manifest gives; then `muse acp` answers
// `initialize` and `session/new` asks for a sign-in. The channel gives no publish time.

import path from 'node:path'
import { acpHandshake } from './acp.mjs'
import { brief, CheckFailure, expect, harnessEnv } from './common.mjs'
import { oldestOf } from './kettu.mjs'

// From the vendor's launcher, https://api.meta.ai/muse-launcher.sh, read on 2026-11-17.
const CHANNEL = 'muse-stable'
const CHANNEL_URL = `https://api.meta.ai/muse-code/channels/${CHANNEL}`
const DOWNLOAD_HOST = 'lookaside.facebook.com'
const VERSION = /^\d+\.\d+\.\d+-R\d+(\.\d+)?$/
const PLATFORMS = {
  'darwin-arm64': 'aarch64_macos',
  'darwin-x64': 'x86_macos',
  'linux-arm64': 'aarch64_linux',
  'linux-x64': 'x86_linux',
  'win32-arm64': 'aarch64_windows',
  'win32-x64': 'x86_windows',
}

/** The release the channel points at; read once a run, since the check asks for it again. */
let channel = null

export const muse = {
  id: 'muse',
  subject: (def) => def.name,

  async versions(def, kettu) {
    channel ??= readChannel()
    const { version } = await channel
    const oldest = oldestOf(def, kettu)
    const inRange = (candidate) => !oldest || kettu.versionAtLeast(candidate, oldest)
    return { versions: inRange(version) ? [{ version, publishedAt: null }] : [], inRange }
  },

  async check(def, version, ctx) {
    ctx.step = 'download'
    channel ??= readChannel()
    // A release's manifest is at the channel's address with its own version, so one the channel
    // moved past can still be checked again.
    const manifestUrl = new URL((await channel).manifestUrl)
    manifestUrl.searchParams.set('version', version)
    const platform = PLATFORMS[`${process.platform}-${process.arch}`]
    expect(platform, `Muse Code has no build for ${process.platform}-${process.arch}`)
    const manifest = await fetchJson(manifestUrl.href)
    expect(manifest.version === version, `The release manifest is for ${brief(manifest.version)}`)
    expect(
      manifest.checksum_algorithm === 'sha256',
      `The release manifest hashes with ${brief(manifest.checksum_algorithm)}`,
    )
    const artifact = manifest.artifacts?.[platform]
    expect(
      typeof artifact?.url === 'string' &&
        isDownload(artifact.url) &&
        /^[0-9a-f]{64}$/.test(artifact.checksum),
      `The release manifest has no usable ${platform} file: ${brief(artifact)}`,
    )
    const cmd = process.platform === 'win32' ? 'muse.exe' : 'muse'
    ctx.log.add(`download ${artifact.url} (${artifact.size} bytes, sha256 ${artifact.checksum})`)
    const install = await ctx.kettu.installArchive({
      root: path.join(ctx.dir, 'installs'),
      agentId: 'muse',
      version,
      url: artifact.url,
      sha256: artifact.checksum,
      cmd,
      args: def.launch.args,
      bare: true,
      platform: process.platform,
      timeoutMs: 15 * 60_000,
    })
    const program = ctx.kettu.programPath(install.dir, cmd, process.platform)

    const env = await harnessEnv(ctx.home, { ...def.env })
    await acpHandshake(program, def.launch.args ?? [], { version, ctx, env })
  },
}

async function readChannel() {
  const answer = await fetchJson(CHANNEL_URL)
  if (
    answer.channel !== CHANNEL ||
    !VERSION.test(answer.version ?? '') ||
    !isDownload(answer.manifest_url ?? '')
  ) {
    throw new Error(`The Muse Code channel answered ${brief(answer)}`)
  }
  return { version: answer.version, manifestUrl: answer.manifest_url }
}

function isDownload(url) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname === DOWNLOAD_HOST
  } catch {
    return false
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new CheckFailure(`${url} answered ${response.status}`)
  const answer = await response.json()
  if (typeof answer !== 'object' || answer === null)
    throw new CheckFailure(`${url} answered ${brief(answer)}`)
  return answer
}
