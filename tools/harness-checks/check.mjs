// The check, every 6 hours, of the harness versions the ACP Registry does not check and of the
// harnesses' preferred interfaces: which new versions to check, the checks, and the results file.
// See README.md.
//
//   node tools/harness-checks/check.mjs [--previous <file>] [--out <file>]
//       [--only <harness>[,<harness>...]] [--version <version>]

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { autohand } from './autohand.mjs'
import { claudeCode } from './claude-code.mjs'
import { clineSdk } from './cline-sdk.mjs'
import { codex } from './codex.mjs'
import { expect, Log } from './common.mjs'
import { deepseek } from './deepseek.mjs'
import { beyondCatalog } from './hosted.mjs'
import { loadKettu, ROOT } from './kettu.mjs'
import { muse } from './muse.mjs'
import { opencodeServer } from './opencode-server.mjs'
import { qoderCn } from './qoder-cn.mjs'

/** The checks; one with a `protocol` checks a harness's preferred interface, kept apart. */
export const HARNESSES = [
  claudeCode,
  codex,
  deepseek,
  qoderCn,
  autohand,
  muse,
  opencodeServer,
  clineSdk,
]

/** How long after publishing a version waits, so npm has every platform package of it. */
const WAIT_MS = 6 * 60 * 60_000
/** New versions of one harness checked in a run, the newest first. */
const NEW_PER_RUN = 3
/** Results kept per harness, the newest versions. */
const KEPT_PER_HARNESS = 20

const { values: options } = parseArgs({
  options: {
    previous: { type: 'string' },
    out: { type: 'string', default: 'harness-checks.json' },
    only: { type: 'string' },
    version: { type: 'string' },
  },
})

const now = new Date()
const kettu = await loadKettu()
const catalog = new Map(kettu.buildCatalog(null).map((def) => [def.id, def]))
const previous = await readPrevious(options.previous)
const only = options.only?.split(',').map((id) => id.trim())
const chosen = only ? HARNESSES.filter((harness) => only.includes(harness.id)) : HARNESSES
if (only && chosen.length !== only.length)
  throw new Error(`Unknown harness in --only ${options.only}`)
if (options.version && chosen.length !== 1)
  throw new Error('--version needs --only with one harness')

const seen = structuredClone(previous.seen)
const outcomes = await Promise.all(chosen.map((harness) => checkHarness(harness)))
const listed = (list) => [
  ...chosen.flatMap((harness, at) => (listOf(harness) === list ? outcomes[at] : [])),
  // A harness left out with --only keeps what the previous run found.
  ...previous[list].filter(
    (result) =>
      !chosen.some((harness) => listOf(harness) === list && harness.id === result.harness),
  ),
]
const byVersion = (a, b) =>
  order(a.harness) - order(b.harness) || kettu.compareVersions(b.version, a.version)
const report = {
  generatedAt: now.toISOString(),
  commit: commitOf(),
  results: listed('results').sort(byVersion),
  interfaces: listed('interfaces').sort(byVersion),
  seen,
}
const out = path.resolve(options.out)
await writeFile(`${out}.partial`, `${JSON.stringify(report, null, 2)}\n`)
await rename(`${out}.partial`, out)
await summarize(report)

function order(id) {
  const at = HARNESSES.findIndex((harness) => harness.id === id)
  return at < 0 ? HARNESSES.length : at
}

/** Where a check's results go: a harness's versions, or the versions of its preferred interface. */
function listOf(harness) {
  return harness.protocol ? 'interfaces' : 'results'
}

async function checkHarness(harness) {
  const def = catalog.get(harness.id)
  if (!def) throw new Error(`The catalog has no ${harness.id}`)
  let listing
  try {
    listing = await harness.versions(def, kettu)
  } catch (error) {
    // Its versions could not be read, from npm or the vendor: the run keeps what it knew.
    console.log(`::warning::${harness.id}: its versions could not be read: ${error.message}`)
    return previous[listOf(harness)].filter((result) => result.harness === harness.id)
  }
  const published = new Map()
  const firstSeen = {}
  for (const { version, publishedAt } of listing.versions) {
    // A vendor that publishes no time counts from the run that first saw the version.
    let at = publishedAt
    if (!at) at = firstSeen[version] = previous.seen[harness.id]?.[version] ?? now.toISOString()
    published.set(version, at)
  }
  if (Object.keys(firstSeen).length > 0) seen[harness.id] = firstSeen
  else delete seen[harness.id]
  const prior = previous[listOf(harness)].filter(
    (result) => result.harness === harness.id && listing.inRange(result.version),
  )
  const candidates = options.version ? [options.version] : pick(harness, prior, published)
  const checked = []
  for (const version of candidates) {
    const before = prior.find((result) => result.version === version)
    const publishedAt = published.get(version) ?? before?.publishedAt ?? now.toISOString()
    checked.push(await runCheck(harness, def, version, publishedAt, before))
  }
  const kept = prior.filter((result) => !checked.some((fresh) => fresh.version === result.version))
  return [...checked, ...kept]
    .sort((a, b) => kettu.compareVersions(b.version, a.version))
    .slice(0, KEPT_PER_HARNESS)
}

/**
 * The versions to check: those published at least WAIT_MS ago that are newer than every version
 * checked before, at most NEW_PER_RUN, or only the newest for a harness never checked; and again
 * those whose one check so far failed, so a second failure in a row can mark them broken.
 */
function pick(harness, prior, published) {
  const ready = [...published]
    .filter(([, at]) => now.getTime() - Date.parse(at) >= WAIT_MS)
    .map(([version]) => version)
    .sort((a, b) => kettu.compareVersions(b, a))
  const newest = prior
    .map((result) => result.version)
    .sort(kettu.compareVersions)
    .at(-1)
  const fresh = ready.filter(
    (version) => newest === undefined || kettu.compareVersions(version, newest) > 0,
  )
  const retries = prior
    .filter((result) => result.status === 'fail' && result.failures === 1)
    .map((result) => result.version)
  const picked = [
    ...new Set([...fresh.slice(0, newest === undefined ? 1 : NEW_PER_RUN), ...retries]),
  ]
  console.log(
    `${harness.id}: ${published.size} versions in range, ${ready.length} published over ` +
      `${WAIT_MS / 3_600_000} h ago; checking ${picked.join(', ') || 'none'}`,
  )
  return picked
}

async function runCheck(harness, def, version, publishedAt, before) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `kettu-harness-${harness.id}-`))
  const log = new Log(dir)
  const ctx = {
    kettu,
    dir,
    home: path.join(dir, 'home'),
    work: path.join(dir, 'work'),
    log,
    step: 'install',
    installPackage: (name, at, install = {}) => installPackage(ctx, name, at, install),
    requireNode: (definition) => requireNode(ctx, definition),
  }
  await mkdir(ctx.work, { recursive: true })
  const started = Date.now()
  log.add(
    `${harness.subject(def)} ${version}, published ${publishedAt}, checked on ` +
      `${process.platform}-${process.arch} with Node.js ${process.versions.node}`,
  )
  let failure = null
  try {
    await harness.check(def, version, ctx)
  } catch (error) {
    // A slip in these tools is no fault of the harness: the run fails rather than mark it broken.
    if (error instanceof TypeError || error instanceof ReferenceError) throw error
    failure = error
    log.add(error?.message ?? String(error))
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }
  const seconds = Math.round((Date.now() - started) / 1000)
  log.add(failure ? `Failed at ${ctx.step} after ${seconds} s` : `Passed in ${seconds} s`)
  console.log(
    `${harness.id} ${version}: ${failure ? `fail at ${ctx.step}` : 'pass'} (${seconds} s)`,
  )
  if (failure) console.log(log.text.replace(/^/gm, '  '))
  const failures = failure ? (before?.status === 'fail' ? before.failures : 0) + 1 : 0
  return {
    harness: harness.id,
    ...(harness.protocol
      ? { protocol: harness.protocol, beyondCatalog: beyondCatalog(def, version) }
      : {}),
    version,
    publishedAt,
    status: failure ? 'fail' : 'pass',
    step: failure ? ctx.step : null,
    log: log.tail(),
    checkedAt: now.toISOString(),
    failures,
  }
}

/** Installs an npm package as the app installs a harness: no install scripts, into a folder of its own. */
async function installPackage(ctx, name, version, { withoutCli = false } = {}) {
  const npm = await kettu.findCommand('npm', {
    platform: process.platform,
    env: process.env,
    isExecutable: (file) => kettu.isExecutableFile(file, process.platform),
  })
  expect(npm, 'npm is not on PATH')
  ctx.log.add(`npm install ${name}@${version}${withoutCli ? ' without its optional CLI' : ''}`)
  const install = await kettu.installAdapter({
    root: path.join(ctx.dir, 'installs'),
    agentId: name.replace(/[^\w.-]+/g, '_'),
    package: name,
    version,
    npm,
    nodeVersion: process.versions.node,
    platform: process.platform,
    env: process.env,
    timeoutMs: 15 * 60_000,
    withoutCli,
  })
  ctx.log.add(`installed ${install.entry}`)
  return install
}

function requireNode(ctx, def) {
  if (!def.requiresNode) return
  expect(
    kettu.satisfiesNode(process.versions.node, def.requiresNode),
    `${def.name} needs Node.js ${def.requiresNode}; this is ${process.versions.node}`,
  )
}

async function readPrevious(file) {
  const none = { results: [], interfaces: [], seen: {} }
  if (!file) return none
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return none
    throw error
  }
  const data = JSON.parse(text)
  if (!Array.isArray(data.results)) throw new Error(`${file} holds no results`)
  // A run from before the preferred interfaces were checked has none of theirs.
  const interfaces = Array.isArray(data.interfaces) ? data.interfaces : []
  return { results: data.results, interfaces, seen: data.seen ?? {} }
}

function commitOf() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
}

function summarize(data) {
  const lines = ['| Harness | Version | Result | Checked |', '| --- | --- | --- | --- |']
  for (const result of [...data.results, ...data.interfaces]) {
    const status =
      result.status === 'pass' ? 'pass' : `fail at ${result.step} (${result.failures} in a row)`
    const fresh = result.checkedAt === data.generatedAt ? 'this run' : result.checkedAt
    const subject = result.protocol ? `${result.harness} (${result.protocol})` : result.harness
    lines.push(`| ${subject} | ${result.version} | ${status} | ${fresh} |`)
  }
  const text = `${lines.join('\n')}\n`
  console.log(text)
  if (process.env.GITHUB_STEP_SUMMARY) {
    return writeFile(process.env.GITHUB_STEP_SUMMARY, `## Harness checks\n\n${text}`, { flag: 'a' })
  }
  return undefined
}
