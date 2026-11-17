// Writes the harness versions a release bundles, src/agent-host/harness-versions.json: the ACP
// Registry's listing cut to what Kettu reads of it, each agent's version and distribution, beside
// `kettu`, the versions Kettu keeps itself for the harnesses the Registry does not list as Kettu
// installs them, which this tool leaves as they are. The Release workflow runs it before the
// build, so every release starts new installs on the day's versions; run it again when a harness
// is added. A failed fetch keeps the committed file and warns in the run.

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const SOURCE = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'
export const TARGET = resolve(import.meta.dirname, '../../src/agent-host/harness-versions.json')

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The fields of a value that are present, in this order. */
function pick(value, keys) {
  return Object.fromEntries(
    keys.filter((key) => value[key] !== undefined).map((k) => [k, value[k]]),
  )
}

/**
 * One agent as Kettu reads it: its id, version and the packages or archives it ships as. The
 * Registry's own arguments and variables are left out, since each harness's launch has its own.
 *
 * @param {Record<string, any>} agent
 */
export function cutAgent(agent) {
  const source = isObject(agent.distribution) ? agent.distribution : {}
  const distribution = {}
  if (isObject(source.npx) && typeof source.npx.package === 'string') {
    distribution.npx = { package: source.npx.package }
  }
  if (isObject(source.uvx) && typeof source.uvx.package === 'string') {
    distribution.uvx = { package: source.uvx.package }
  }
  if (isObject(source.binary)) {
    distribution.binary = Object.fromEntries(
      Object.entries(source.binary)
        .filter(([, target]) => isObject(target))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, target]) => [key, pick(target, ['archive', 'cmd', 'args', 'sha256'])]),
    )
  }
  return { id: agent.id, version: agent.version, distribution }
}

/**
 * The bundled file from the Registry's listing and the versions Kettu keeps itself.
 *
 * @param {{ agents: unknown[] }} listing
 * @param {Record<string, unknown>} kettu
 */
export function bundle(listing, kettu) {
  const agents = listing.agents
    .filter((agent) => isObject(agent) && typeof agent.id === 'string')
    .map(cutAgent)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { registry: { agents }, kettu }
}

/** Formats the file as the repository's Prettier settings do, so it passes the format check. */
async function format(text) {
  const prettier = await import('prettier')
  const options = (await prettier.resolveConfig(TARGET)) ?? {}
  return prettier.format(text, { ...options, filepath: TARGET })
}

async function main() {
  let current
  try {
    current = JSON.parse(readFileSync(TARGET, 'utf8'))
  } catch (error) {
    throw new Error(`Could not read ${TARGET}: ${error.message}`, { cause: error })
  }
  let listing
  try {
    const response = await fetch(SOURCE)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    listing = await response.json()
    if (!isObject(listing) || !Array.isArray(listing.agents)) throw new Error('no agents list')
  } catch (error) {
    console.warn(
      `::warning::Could not read the ACP Registry, keeping the committed harness versions: ${error.message}`,
    )
    return
  }
  const next = bundle(listing, isObject(current.kettu) ? current.kettu : {})
  writeFileSync(TARGET, await format(JSON.stringify(next, null, 2)))
  console.log(`Wrote the versions of ${next.registry.agents.length} Registry agents`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
