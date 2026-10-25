// Takes a fresh LiteLLM price snapshot for the usage page, cut to the chat models and the prices
// OverBench counts with. The Release workflow runs it before the build, so every release carries
// its day's prices; the app never fetches anything. `--if-changed` leaves the file alone when no
// price changed. A failed fetch keeps the committed snapshot and warns in the run.

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const SOURCE =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
export const TARGET = resolve(import.meta.dirname, '../../src/agent-host/usage/prices.json')

const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'none'])

/** The app's `normalizeModel`; it stays here so the tool runs from a checkout with plain Node. */
function normalizeModel(name) {
  let model = (name ?? '').trim().toLowerCase()
  model = model.replace(/\[[^\]]*\]$/, '')
  const parts = model.split('/').filter(Boolean)
  if (parts.length > 1 && EFFORTS.has(parts[parts.length - 1])) parts.pop()
  model = parts[parts.length - 1] ?? ''
  return model.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '')
}

const price = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/**
 * The chat models of LiteLLM's list that carry an input and an output price, keyed by
 * `normalizeModel`: an unprefixed name wins over a provider-prefixed one, and so does the first
 * alphabetically among names of the same kind, so the same list always cuts the same way.
 *
 * @param {Record<string, any>} source
 * @param {string} asOf
 * @returns {{ asOf: string, models: Record<string, { input: number, output: number, cacheRead: number, cacheWrite: number, cacheWrite1h?: number }> }}
 */
export function cutPrices(source, asOf) {
  const cut = new Map()
  for (const [name, entry] of Object.entries(source)) {
    if (entry?.mode !== 'chat') continue
    const input = entry.input_cost_per_token
    const output = entry.output_cost_per_token
    if (typeof input !== 'number' || typeof output !== 'number') continue
    const key = normalizeModel(name)
    if (!key) continue
    const prefixed = name.includes('/')
    const known = cut.get(key)
    if (known) {
      const wins = known.prefixed === prefixed ? known.name <= name : !known.prefixed
      if (wins) continue
    }
    const prices = {
      input,
      output,
      cacheRead: price(entry.cache_read_input_token_cost),
      cacheWrite: price(entry.cache_creation_input_token_cost),
    }
    const hour = entry.cache_creation_input_token_cost_above_1hr
    if (typeof hour === 'number' && Number.isFinite(hour)) prices.cacheWrite1h = hour
    cut.set(key, { name, prefixed, prices })
  }
  const models = {}
  for (const key of [...cut.keys()].sort()) models[key] = cut.get(key).prices
  return { asOf, models }
}

function sameModels(current, next) {
  return JSON.stringify(current?.models) === JSON.stringify(next.models)
}

async function main() {
  const ifChanged = process.argv.includes('--if-changed')
  let source
  try {
    const response = await fetch(SOURCE)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    source = await response.json()
  } catch (error) {
    console.warn(
      `::warning::Could not fetch LiteLLM's prices, keeping the committed snapshot: ${error.message}`,
    )
    return
  }
  const next = cutPrices(source, new Date().toISOString().slice(0, 10))
  if (ifChanged) {
    let current = null
    try {
      current = JSON.parse(readFileSync(TARGET, 'utf8'))
    } catch {
      // No usable file yet, so there is something to write either way.
    }
    if (sameModels(current, next)) {
      console.log('Prices unchanged')
      return
    }
  }
  writeFileSync(TARGET, `${JSON.stringify(next, null, 2)}\n`)
  console.log(`Wrote ${Object.keys(next.models).length} model prices as of ${next.asOf}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
