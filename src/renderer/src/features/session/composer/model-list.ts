import type { ConfigOption } from '@shared/thread'
import { splitName } from './levels'

type Choice = NonNullable<ConfigOption['choices']>[number]
type Choices = readonly Choice[]

// The main list holds this many models, each with a number key, before More models.
export const MAIN_MODELS = 4

/** The value whose row stands for the current model: the one it is shown as, else its own. */
export function shownValue(choices: Choices, current: string | undefined): string | undefined {
  return choices.find((c) => c.value === current)?.shownAs ?? current
}

/** The choice whose name stands for the current model, by the same rule as `shownValue`. */
export function shownChoice(choices: Choices, current: string | undefined): Choice | undefined {
  const value = shownValue(choices, current)
  return choices.find((c) => c.value === value)
}

/** One model as the menus read it: from which provider, of which family, at which version. */
export interface ModelRead {
  choice: Choice
  value: string
  /** The name without a `provider/` prefix. */
  name: string
  /** The agent's group for it, else the part of its name, or its value, before the last `/`. */
  provider: string
  /** The family within the provider, lower case; a model without a version is one of its own. */
  family: string
  /** The family's name as a row shows it, such as Opus or DeepSeek Flash. */
  familyName: string
  version: number[] | null
  /** The version as written, such as 5.5, without a leading v. */
  versionName: string | null
  /** Its place in the agent's list. */
  order: number
  /** A lower version than the newest of its family, or one the agent marks older. */
  older: boolean
  /** The agent's Default, on a row of its own since it stands for no listed model. */
  isDefault: boolean
}

const isDefaultChoice = (c: Choice): boolean =>
  /^default$/i.test(c.value) || /^default\b/i.test(c.name)

// What follows a model's name and qualifies it, as in "GPT-6.2-Sol · Codex" or "(Thinking)".
const QUALIFIER = /\s+(?:·|\()/

/** A name without its qualifier, and the qualifier bare, as "1M context" from "Opus (1M context)". */
export function splitQualifier(name: string): [main: string, qualifier: string] {
  const at = QUALIFIER.exec(name)
  if (!at) return [name, '']
  const rest = name.slice(at.index).trim().replace(/^·\s*/, '')
  return [name.slice(0, at.index), /^\(.*\)$/.test(rest) ? rest.slice(1, -1) : rest]
}
// A version, as in 5.5, V4.1 or 6; three digits at most, so a build such as 1017 is no version.
const NUMBER = /^[vV]?(\d{1,3}(?:\.\d+)*)$/
// A version written onto its family's word, as in Qwen3.6 or K2.
const ATTACHED = /^([A-Za-z]+)(\d{1,3}(?:\.\d+)*)$/
// A date in an id, as in claude-haiku-4-5-20251001.
const DATE = /^\d{6,}$/

/**
 * The version in `text` and the words around it. In an id, numbers joined by dashes are one version
 * (`claude-opus-4-8` is 4.8) and a date is dropped.
 */
function readVersion(text: string, id = false): { words: string[]; version: string } | null {
  const parts = text.split(/([\s_-]+)/)
  for (let i = 0; i < parts.length; i += 2) {
    const token = parts[i]!
    const number = NUMBER.exec(token)
    const attached = number ? null : ATTACHED.exec(token)
    if (!number && !attached) continue
    let version = number ? number[1]! : attached![2]!
    let end = i
    if (number && !version.includes('.')) {
      while (parts[end + 1] === '-' && /^\d{1,2}$/.test(parts[end + 2] ?? '')) {
        version += `.${parts[end + 2]}`
        end += 2
      }
    }
    const words = [
      ...parts.slice(0, i).filter((_, k) => k % 2 === 0),
      ...(attached ? [attached[1]!] : []),
      ...parts.slice(end + 1).filter((_, k) => k % 2 === 1),
    ].filter((word) => word && !(id && DATE.test(word)))
    return { words, version }
  }
  return null
}

function versionOf(name: string): number[] {
  return name.split('.').map(Number)
}

/** Below, at or above zero as version `a` is lower than, the same as or higher than `b`. */
function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

function providerOf(choice: Choice): string {
  if (choice.group) return choice.group
  const named = choice.name.lastIndexOf('/')
  if (named > 0) return choice.name.slice(0, named)
  const valued = choice.value.lastIndexOf('/')
  return valued > 0 ? choice.value.slice(0, valued) : ''
}

/** Reads one model: its family and version from its name, else from its id. */
function readModel(choice: Choice, order: number): ModelRead {
  const name = splitName(choice.name)[1]
  const provider = providerOf(choice)
  const isDefault = isDefaultChoice(choice)
  const base = { choice, value: choice.value, name, provider, order, isDefault, older: false }
  const at = QUALIFIER.exec(name)
  const [main, qualifier] = at ? [name.slice(0, at.index), name.slice(at.index).trim()] : [name, '']
  // A name such as claude-opus-4-1 is an id, whose dashes join its version's numbers.
  const looksLikeId = !/\s/.test(main) && main.includes('-')
  const named = isDefault ? null : readVersion(main, looksLikeId)
  if (named) {
    const familyName = [...named.words, qualifier].filter(Boolean).join(' ')
    return {
      ...base,
      family: familyName.toLowerCase(),
      familyName,
      version: versionOf(named.version),
      versionName: named.version,
    }
  }
  const id = choice.modelId ?? choice.value
  const fromId = isDefault ? null : readVersion(id.slice(id.lastIndexOf('/') + 1), true)
  if (fromId) {
    return {
      ...base,
      family: [...fromId.words, qualifier].filter(Boolean).join(' ').toLowerCase(),
      familyName: name,
      version: versionOf(fromId.version),
      versionName: fromId.version,
    }
  }
  return { ...base, family: name.toLowerCase(), familyName: name, version: null, versionName: null }
}

// Families Kettu knows, each vendor's largest first.
const KNOWN_FAMILIES: { vendor: string; families: RegExp[] }[] = [
  { vendor: 'claude', families: [/\bfable\b/, /\bopus\b/, /\bsonnet\b/, /\bhaiku\b/] },
  { vendor: 'openai', families: [/\bastra\b/, /\bsol\b/, /\bterra\b/, /\bluna\b/] },
]

function knownFamily(read: ModelRead): { vendor: string; size: number } | null {
  if (read.isDefault) return null
  for (const { vendor, families } of KNOWN_FAMILIES) {
    const size = families.findIndex((pattern) => pattern.test(read.family))
    if (size >= 0) return { vendor, size }
  }
  return null
}

/**
 * Sorts known families ahead, each vendor's together and largest first, the vendors in the order
 * the agent first lists them; the other models follow in the agent's order.
 */
function sortByFamily<T>(items: readonly T[], readOf: (item: T) => ModelRead): T[] {
  const firstOf = new Map<string, number>()
  for (const item of items) {
    const read = readOf(item)
    const known = knownFamily(read)
    if (known)
      firstOf.set(known.vendor, Math.min(firstOf.get(known.vendor) ?? read.order, read.order))
  }
  const key = (item: T): number[] => {
    const read = readOf(item)
    const known = knownFamily(read)
    return known ? [0, firstOf.get(known.vendor)!, known.size, read.order] : [1, read.order, 0, 0]
  }
  return [...items].sort((a, b) => compareVersions(key(a), key(b)))
}

/** Marks the models below the newest version of their provider's family as older. */
function markOlder(reads: ModelRead[]): void {
  const families = new Map<string, ModelRead[]>()
  for (const read of reads) {
    if (!read.version) continue
    const key = `${read.provider}\0${read.family}`
    families.set(key, [...(families.get(key) ?? []), read])
  }
  for (const read of reads) {
    if (read.isDefault) continue
    const marked = !!read.choice.older
    if (!read.version) {
      read.older = marked
      continue
    }
    const members = families.get(`${read.provider}\0${read.family}`)!
    const lower = members.some((r) => compareVersions(read.version!, r.version!) < 0)
    // The agent's own mark holds unless the versions show the model is its family's newest.
    read.older = lower || (marked && members.length === 1)
  }
}

/** What the host keeps of an agent's models: the ones pinned and the ones last used. */
export interface KeptModels {
  pinned?: readonly string[]
  recent?: readonly string[]
}

export interface ModelLists {
  /** Every model the agent lists, but one shown as another, in the agent's order. */
  all: ModelRead[]
  /** The main list, at most `MAIN_MODELS`, in the order it shows them. */
  main: ModelRead[]
  /** The chosen model's row. */
  chosen: ModelRead | null
  /** The chosen model when the main list leaves it out: a row after the main list. */
  extra: ModelRead | null
  /** What More models lists: every model the main list leaves out, in the agent's order. */
  more: ModelRead[]
  /** Whether the models come from several providers, which their rows then name. */
  several: boolean
  /** The model the agent's Default stands for, whose row carries the Default tag. */
  defaultValue: string | null
}

/**
 * The model menus' lists, by one rule for every agent. The main list takes, up to four, the models
 * the user pinned, then from one provider its current generation (the newest of each family) or
 * from several the agent's recently used models, then the agent's current models in its order.
 * Pinned models lead in the order pinned; the rest go known families largest first.
 */
export function modelLists(
  choices: Choices,
  current: string | undefined,
  kept: KeptModels = {},
): ModelLists {
  const all = choices.filter((c) => !c.shownAs).map((c, i) => readModel(c, i))
  markOlder(all)
  const byValue = new Map(all.map((r) => [r.value, r]))
  const several = new Set(all.filter((r) => !r.isDefault).map((r) => r.provider)).size > 1
  const picked: ModelRead[] = []
  const take = (read: ModelRead | undefined) => {
    if (read && picked.length < MAIN_MODELS && !picked.includes(read)) picked.push(read)
  }
  const pinned = (kept.pinned ?? []).flatMap((v) => byValue.get(v) ?? [])
  pinned.forEach(take)
  const currentModels = all.filter((r) => !r.older)
  const self = (read: ModelRead) => read
  if (several) for (const value of kept.recent ?? []) take(byValue.get(value))
  else
    sortByFamily(
      currentModels.filter((r) => !r.isDefault),
      self,
    ).forEach(take)
  currentModels.forEach(take)
  // An agent that marks every model older still gets a main list.
  if (picked.length === 0) all.forEach(take)
  const main = [
    ...pinned.filter((r) => picked.includes(r)),
    ...sortByFamily(
      picked.filter((r) => !pinned.includes(r)),
      self,
    ),
  ]
  const chosenValue = shownValue(choices, current)
  const chosen = all.find((r) => r.value === chosenValue) ?? null
  const shownAs = choices.find((c) => c.shownAs && isDefaultChoice(c))?.shownAs ?? null
  return {
    all,
    main,
    chosen,
    extra: chosen && !main.includes(chosen) ? chosen : null,
    more: all.filter((r) => !main.includes(r)),
    several,
    defaultValue: shownAs && byValue.has(shownAs) ? shownAs : null,
  }
}

/** The model a number key chooses among the main list's first four, for 1 to 4. */
export function numberedModel(main: readonly ModelRead[], key: string): ModelRead | undefined {
  const n = Number(key)
  return Number.isInteger(n) && n >= 1 && n <= MAIN_MODELS ? main[n - 1] : undefined
}

/** One family's row in More models: its newest version first, a model without one alone. */
export interface FamilyRow {
  key: string
  name: string
  models: ModelRead[]
  /** Whether its models have versions, which then show as chips. */
  versioned: boolean
}

export interface ProviderGroup<T> {
  provider: string
  items: T[]
}

/** Models grouped by provider, in the order the agent first lists each, then into families. */
export function familyGroups(models: readonly ModelRead[]): ProviderGroup<FamilyRow>[] {
  const groups = new Map<string, Map<string, ModelRead[]>>()
  for (const read of models) {
    const families = groups.get(read.provider) ?? new Map<string, ModelRead[]>()
    groups.set(read.provider, families)
    const key = read.version ? read.family : `\0${read.value}`
    families.set(key, [...(families.get(key) ?? []), read])
  }
  return [...groups].map(([provider, families]) => ({
    provider,
    items: sortByFamily(
      [...families].map(([key, members]) => ({
        key,
        name: members[0]!.familyName,
        models: [...members].sort(
          (a, b) => compareVersions(b.version ?? [], a.version ?? []) || a.order - b.order,
        ),
        versioned: !!members[0]!.version,
      })),
      (row) => row.models[0]!,
    ),
  }))
}

/** More models in one list, as their families show them: by provider, each family's newest first. */
export function moreInOrder(more: readonly ModelRead[]): ModelRead[] {
  return familyGroups(more).flatMap((group) => group.items.flatMap((row) => row.models))
}

/** What a search of the models looks in: the provider, the name and the id. */
export function modelHaystack(read: ModelRead): string {
  const { choice } = read
  return [read.provider, choice.name, choice.value, choice.modelId ?? ''].join(' ')
}

/** Whether every word of `query` is in the model's provider, name or id, ignoring case. */
export function matchesModel(read: ModelRead, query: string): boolean {
  const hay = modelHaystack(read).toLocaleLowerCase()
  return query
    .toLocaleLowerCase()
    .split(/\s+/)
    .every((word) => hay.includes(word))
}

/** The models a search finds among `all`, each family's newest first, by provider. */
export function searchModels(all: readonly ModelRead[], query: string): ProviderGroup<ModelRead>[] {
  const q = query.trim()
  return familyGroups(all)
    .map(({ provider, items }) => ({
      provider,
      items: items.flatMap((row) => row.models).filter((read) => matchesModel(read, q)),
    }))
    .filter((group) => group.items.length > 0)
}

/** The model the agent's Default runs, by its name when listed, for a Default on a row of its own. */
export function defaultUses(read: ModelRead, all: readonly ModelRead[]): string | null {
  const id = read.choice.modelId
  if (!id) return null
  return all.find((r) => !r.isDefault && (r.choice.modelId ?? r.value) === id)?.name ?? id
}
