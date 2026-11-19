// The model routes of a DeepSeek Harness home. dsh keeps them as plugin config in a profile's
// `cordis.patch.yml`: what the user sets up in its web page or its desktop app is in that
// profile's file, and the `sdk` profile Kettu runs composes only its own file and the home's.
// Kettu reads every profile's rows and hands them to its process as `--patch` rows, so a session
// runs on any model the user configured in dsh. Its SDK wire has no call that lists models.

import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { Document, YAMLMap, YAMLSeq, isMap, isScalar, isSeq, parseDocument } from 'yaml'

const PATCH_FILE = 'cordis.patch.yml'
const SDK_PROFILE = 'sdk'

/** The entries of dsh's tree that decide which models a session can run on. */
const PI_AI = 'llm-pi-ai'
const DEEPSEEK = 'llm-deepseek'
const DEEPSEEK_ACCOUNT = 'llm-deepseek-account'
const DEFAULT_MODEL = 'agent-default-model'
const ENTRIES = [PI_AI, DEEPSEEK, DEEPSEEK_ACCOUNT, DEFAULT_MODEL] as const

type EntryId = (typeof ENTRIES)[number]

export interface RouteModel {
  id: string
  name: string
  /** The reasoning levels the model declares; null when it follows its route's own. */
  efforts: string[] | null
}

export interface RouteGroup {
  provider: string
  name: string
  /** The level the route starts a session on, when its config says. */
  effort: string | null
  models: RouteModel[]
}

export interface Routes {
  /** The rows for dsh's `--patch`; empty when no file configures a model. */
  yaml: string
  /** The routes whose models the files list, in the order they were written. */
  groups: RouteGroup[]
  /** What a file sets on DeepSeek's own route; `models` is null while it keeps dsh's catalog. */
  deepseek: { models: RouteModel[] | null; effort: string | null } | null
  /** The model dsh starts a new session on, when a file says. */
  selection: { provider: string; model: string; effort: string | null } | null
}

/** A home that configures no model. */
export const NO_ROUTES: Routes = { yaml: '', groups: [], deepseek: null, selection: null }

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** A catalog's entries; `inherit` is what an entry without levels of its own has. */
function models(value: unknown, inherit: string[] | null): RouteModel[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): RouteModel[] => {
    const model = record(entry)
    const id = text(model?.id)
    if (!model || !id) return []
    const levels = record(model.reasoningEfforts)
    const efforts = levels ? Object.keys(levels) : model.reasoningEfforts === false ? [] : inherit
    return [{ id, name: text(model.name) ?? id, efforts }]
  })
}

/** The rows of one file that configure a model entry, by entry; a later row replaces an earlier. */
function rowsOf(source: string): Map<EntryId, YAMLMap> {
  const rows = new Map<EntryId, YAMLMap>()
  const doc = parseDocument(source)
  if (doc.errors.length > 0 || !isSeq(doc.contents)) return rows
  for (const item of doc.contents.items) {
    if (!isMap(item)) continue
    const id: unknown = item.get('id', true)
    const config = item.get('config', true)
    const name: unknown = isScalar(id) ? id.value : null
    const entry = ENTRIES.find((known) => known === name)
    if (entry && isMap(config)) rows.set(entry, config)
  }
  return rows
}

/**
 * The routes of several `cordis.patch.yml` files, the later of two winning: a row replaces the
 * entry's whole config as it does in dsh, except that routes of different names add up, since each
 * of dsh's own pages lists the routes of its profile alone.
 */
export function mergeRoutes(sources: readonly string[]): Routes {
  const providers = new YAMLMap()
  const configs = new Map<EntryId, YAMLMap>()
  for (const source of sources) {
    for (const [entry, config] of rowsOf(source)) {
      if (entry !== PI_AI) {
        configs.set(entry, config)
        continue
      }
      const routes = config.get('providers', true)
      if (isMap(routes)) for (const pair of routes.items) providers.set(pair.key, pair.value)
    }
  }
  if (providers.items.length > 0) {
    const config = new YAMLMap()
    config.set('providers', providers)
    configs.set(PI_AI, config)
  }
  if (configs.size === 0) return NO_ROUTES

  const rows = new YAMLSeq()
  for (const entry of ENTRIES) {
    const config = configs.get(entry)
    if (!config) continue
    const row = new YAMLMap()
    row.set('id', entry)
    row.set('config', config)
    rows.add(row)
  }
  const doc = new Document(rows)
  let yaml: string
  let plain: unknown
  try {
    yaml = doc.toString()
    plain = doc.toJS()
  } catch {
    // An alias whose anchor stayed behind in its file cannot be written out.
    return NO_ROUTES
  }

  const byId = new Map<string, Record<string, unknown>>()
  for (const row of Array.isArray(plain) ? plain : []) {
    const config = record(record(row)?.config)
    const id = text(record(row)?.id)
    if (id && config) byId.set(id, config)
  }

  const groups: RouteGroup[] = []
  for (const [provider, value] of Object.entries(record(byId.get(PI_AI)?.providers) ?? {})) {
    const profile = record(value)
    const listed = models(profile?.models, [])
    if (!profile || listed.length === 0) continue
    groups.push({
      provider,
      name: text(profile.displayName) ?? provider,
      effort: text(profile.reasoning),
      models: listed,
    })
  }

  const own = byId.get(DEEPSEEK)
  const catalog = own ? models(own.models, null) : []
  const chosen = byId.get(DEFAULT_MODEL)
  const provider = text(chosen?.provider)
  const model = text(chosen?.model)
  return {
    yaml,
    groups,
    deepseek: own
      ? { models: catalog.length > 0 ? catalog : null, effort: text(own.reasoningEffort) }
      : null,
    selection:
      provider && model ? { provider, model, effort: text(chosen?.reasoningEffort) } : null,
  }
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * The home's patch files from the least to the most telling: the other profiles by when they were
 * last changed, then the `sdk` profile Kettu runs, then the home's own file, which dsh puts over
 * every profile.
 */
async function patchFiles(home: string): Promise<string[]> {
  const profiles = path.join(home, 'profiles')
  const names = await readdir(profiles).catch((): string[] => [])
  const others = (
    await Promise.all(
      names
        .filter((name) => name !== SDK_PROFILE)
        .map(async (name) => {
          const file = path.join(profiles, name, PATCH_FILE)
          const modified = await stat(file).then(
            (stats) => stats.mtimeMs,
            () => null,
          )
          return modified === null ? [] : [{ file, modified }]
        }),
    )
  )
    .flat()
    .sort((a, b) => a.modified - b.modified || a.file.localeCompare(b.file))
  return [
    ...others.map((entry) => entry.file),
    path.join(profiles, SDK_PROFILE, PATCH_FILE),
    path.join(home, PATCH_FILE),
  ]
}

/** The model routes every profile of the dsh home configures. */
export async function readRoutes(home: string): Promise<Routes> {
  const sources = await Promise.all((await patchFiles(home)).map(readText))
  return mergeRoutes(sources.filter((source) => source !== null))
}
