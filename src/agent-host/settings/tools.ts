// The settings tools of Kettu's MCP service: an agent finds Kettu's settings with their values,
// takes the user to a row, and changes rows for them. Full access changes them at once and leaves
// a line in the thread; any other mode, and the rows that widen what agents, devices or the
// network may do, wait for the user's answer in a card. Secrets, paths and actions never change
// through them, and a secret's value never leaves the host.

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { CONTROL_WAIT_MS } from '@shared/control'
import type { SettingFacts, SettingsSnapshot } from '@shared/host-control'
import type { Platform } from '@shared/platform'
import type { SettingsPatch } from '@shared/settings'
import {
  CATALOG,
  changeable,
  coerce,
  keywordKeys,
  literalWords,
  lockedNow,
  mergePatches,
  optionsOf,
  optionWords,
  parseToolId,
  platformKey,
  present,
  presentRows,
  rowTarget,
  sameValue,
  toolId,
  type CatalogContext,
  type CatalogEntry,
  type SettingId,
  type SettingScalar,
  type SettingsSection,
} from '@shared/settings-catalog'
import type { SettingChangeItem, SettingsChangeOutcome } from '@shared/thread'
import { matchesWords } from '@shared/word-match'
import type { Caller } from '../artifacts/tools'

export const FIND_SETTINGS = 'find_settings'
export const OPEN_SETTINGS = 'open_settings'
export const CHANGE_SETTINGS = 'change_settings'
/** Allowed when the agent starts: Kettu's own card is the only ask. */
export const SETTINGS_TOOL_NAMES = [FIND_SETTINGS, OPEN_SETTINGS, CHANGE_SETTINGS]
/** How long a card waits before nothing changes. */
export const SETTINGS_WAIT_MS = 10 * 60_000
/** The rows one call may change. */
export const MAX_CHANGES = 20
/** The rows a search lists in full, with their descriptions and values. */
const MAX_FOUND = 40
const QUERY_CHARS = 200
const ID_CHARS = 200
const VALUE_CHARS = 2048

export const SETTINGS_TOOLS: Tool[] = [
  {
    name: FIND_SETTINGS,
    title: "Find Kettu's settings",
    description:
      "Finds rows of Kettu's Settings page by words in any language, matched as the page's own " +
      'search matches them, with each row’s place, name in the user’s language and in English, ' +
      'current value, the values it takes and whether you may change it. Without words it lists ' +
      'every section and its rows. These are the settings of the computer this session runs on. ' +
      'Secrets read only as set or not set; lists give only their count.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          maxLength: QUERY_CHARS,
          description: 'Words to find, such as "dark mode" or "深色"; empty lists every row.',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: OPEN_SETTINGS,
    title: 'Open Kettu’s Settings at a row',
    description:
      'Opens Settings at a row in the Kettu window that shows this session, and flashes it, as ' +
      'a search result does: for a row you may not change, such as a sign-in, a secret, a path ' +
      'or an action, so the user does it there. With no desktop window showing this session it ' +
      'opens nothing and says so; then tell the user where the row is.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          minLength: 1,
          maxLength: ID_CHARS,
          description: 'The row’s id from find_settings, such as appearance.color-mode.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: CHANGE_SETTINGS,
    title: "Change Kettu's settings",
    description:
      "Changes one or several rows of Kettu's settings, all of them or none, only when the user " +
      'asked for it. In Full access it changes them at once and the thread shows a line the user ' +
      'can undo; in any other mode, and for the rows that widen what agents, devices or the ' +
      'network may do, the user answers a card in this session, which waits up to 10 minutes. ' +
      'This call returns within a minute: if it says the user has not answered yet, call it ' +
      'again with the same changes, which shows no second card and returns what became of this ' +
      'one. A value the row does not take is an error that lists the values it does. Secrets, ' +
      'paths and actions never change here: use open_settings so the user does them.',
    inputSchema: {
      type: 'object',
      properties: {
        changes: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_CHANGES,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1, maxLength: ID_CHARS },
              value: {
                description:
                  'One of the values find_settings lists for the row: true or false for a ' +
                  'switch, a choice’s value, a whole number or a text; null for a choice’s ' +
                  'default where it has one.',
              },
            },
            required: ['id', 'value'],
            additionalProperties: false,
          },
        },
      },
      required: ['changes'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
]

const NAMES = new Set(SETTINGS_TOOL_NAMES)

export function isSettingsToolName(name: string): boolean {
  return NAMES.has(name)
}

type Words = (key: string, params?: Record<string, string | number>) => string

/** What a card asks, as the host adds it to the thread. */
export interface SettingsAsk {
  items: SettingChangeItem[]
}

/** The user's answer to a card, or how it ended without one. */
export type SettingsAnswer = { decision: 'change' } | { decision: 'keep' | 'expired' | 'ended' }

/** What the host knows of itself beyond the settings file, for the catalog and its facts. */
export interface LocalFacts {
  agents: CatalogContext['agents']
  harnesses: CatalogContext['harnesses']
  modes: CatalogContext['modes']
  plugins: CatalogContext['plugins']
  facts: SettingFacts
}

export interface SettingsToolsDeps {
  platform: Platform
  /** The settings and the owner's facts, from main or the daemon. */
  read(): Promise<SettingsSnapshot>
  /** Applies a patch with the Settings page's checks; throws the owner's reason when refused. */
  apply(patch: SettingsPatch): Promise<SettingsSnapshot>
  /** Sets a setting a plugin declares, kept in the plugin's own record; throws why it cannot. */
  setPluginSetting(pluginId: string, key: string, value: SettingScalar): Promise<void>
  local(): Promise<LocalFacts>
  /** The session's mode is Full access now, and it is a session of the user's own. */
  fullAccess(sessionId: string): boolean
  /** Adds the card to the thread; null for a session Kettu holds no thread for. */
  ask(
    sessionId: string,
    ask: SettingsAsk,
  ): { entryId: string; answer: Promise<SettingsAnswer> } | null
  /** Adds the line of a change made without asking; null for a session without a thread. */
  recorded(sessionId: string, items: SettingChangeItem[]): string | null
  settle(sessionId: string, entryId: string, outcome: SettingsChangeOutcome): void
  /** Opens Settings at the row in a desktop window showing the session; false when none does. */
  open(sessionId: string, target: SettingsTarget): boolean
  /** Words in the user's language, and in English. */
  words: Words
  english: Words
}

/** Where open_settings and View in Settings take the user. */
export interface SettingsTarget {
  section: SettingsSection
  item: string | null
  row: string
  /** A row of the desktop app's own, which a window showing another host's session lacks. */
  desktop: boolean
}

interface Row {
  id: SettingId
  item: string | null
  entry: CatalogEntry
}

/** A card a call opened, which the agent's next call with the same changes picks up. */
interface CardJob {
  key: string
  count: number
  confirmed: boolean
  result: Promise<CallToolResult>
}

class Refusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Refusal'
  }
}

const SECTION_TITLES: Partial<Record<SettingsSection, string>> = {
  usage: 'usage:settings.title',
}

function sectionTitle(section: SettingsSection): string {
  return SECTION_TITLES[section] ?? `sections.${section}`
}

/**
 * A result whose words go in its structured content too, since an agent that reads the structured
 * content alone, as Claude Code does, would miss what to do next.
 */
function reply(text: string, data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: { message: text, ...data } }
}

function failed(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function fields(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (input === undefined) return {}
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Refusal('The arguments must be an object.')
  }
  const o = input as Record<string, unknown>
  const unknown = Object.keys(o).find((key) => !allowed.includes(key))
  if (unknown !== undefined) throw new Refusal(`Unknown argument ${unknown}.`)
  return o
}

/** Keys in a fixed order, so two equal objects read the same. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const o = value as Record<string, unknown>
    return `{${Object.keys(o)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(o[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export class SettingsTools {
  /** The cards calls opened, by session. */
  private readonly jobs = new Map<string, CardJob[]>()

  constructor(private readonly deps: SettingsToolsDeps) {}

  /** The session's turn ended: a later turn's call with the same changes asks again. */
  turnEnded(sessionId: string): void {
    this.jobs.delete(sessionId)
  }

  /** Serves a call; a refusal becomes a tool error whose text says why. */
  async call(caller: Caller, name: string, input: unknown): Promise<CallToolResult> {
    const deadline = Date.now() + CONTROL_WAIT_MS
    try {
      switch (name) {
        case FIND_SETTINGS:
          return await this.find(input)
        case OPEN_SETTINGS:
          return await this.openRow(caller, input)
        case CHANGE_SETTINGS:
          return await this.change(caller, input, deadline)
        default:
          throw new Error(`Unknown tool ${name}`)
      }
    } catch (error) {
      if (error instanceof Refusal) return failed(error.message)
      throw error
    }
  }

  /** Sets a change's rows back, unless one of them changed again since. */
  async undo(items: readonly SettingChangeItem[]): Promise<void> {
    const snapshot = await this.deps.read()
    const local = await this.deps.local()
    const ctx = this.context(snapshot, local)
    const facts = { ...snapshot.facts, ...local.facts }
    const patches: SettingsPatch[] = []
    const plugins: { row: Row; to: SettingScalar }[] = []
    for (const item of items) {
      const row = this.rowOf(item.id, ctx)
      if (!row || !(row.entry.patch || row.entry.store === 'plugin')) {
        throw new Refusal(`${item.name} can no longer be undone here.`)
      }
      const now = this.valueOf(row, snapshot, facts) ?? null
      if (!sameValue(now, item.to.value)) {
        throw new StaleUndo(`${item.place} › ${item.name} changed again since.`)
      }
      if (row.entry.store === 'plugin') plugins.push({ row, to: item.from.value })
      else patches.push(row.entry.patch!(item.from.value, snapshot.file, row.item))
    }
    await this.applyAll(patches, plugins)
  }

  /** Applies what the rows are to hold, to the settings file and to the plugins' own records. */
  private applyItems(
    items: { row: Row; to: SettingScalar }[],
    snapshot: SettingsSnapshot,
  ): Promise<void> {
    const plugins = items.filter(({ row }) => row.entry.store === 'plugin')
    const patches = items
      .filter(({ row }) => row.entry.store !== 'plugin')
      .map(({ row, to }) => row.entry.patch!(to, snapshot.file, row.item))
    return this.applyAll(patches, plugins)
  }

  /** Applies the file's patches, then each plugin's own settings. */
  private async applyAll(
    patches: SettingsPatch[],
    plugins: { row: Row; to: SettingScalar }[],
  ): Promise<void> {
    if (patches.length > 0) await this.deps.apply(mergePatches(patches))
    for (const { row, to } of plugins) {
      const at = row.item!.indexOf(':')
      await this.deps.setPluginSetting(row.item!.slice(0, at), row.item!.slice(at + 1), to)
    }
  }

  /** The catalog's context on this host, from the owner's snapshot and what the host knows. */
  private context(snapshot: SettingsSnapshot, local: LocalFacts): CatalogContext {
    return {
      platform: this.deps.platform,
      desktop: snapshot.desktop,
      cloud: snapshot.file.cloud.enabled,
      agents: local.agents,
      harnesses: local.harnesses,
      modes: local.modes,
      plugins: local.plugins,
    }
  }

  private rowOf(id: string, ctx: CatalogContext): Row | null {
    const parsed = parseToolId(id)
    if (!parsed) return null
    const entry = CATALOG[parsed.id]
    if (!present(entry, ctx, parsed.item)) return null
    return { id: parsed.id, item: parsed.item, entry }
  }

  private async find(input: unknown): Promise<CallToolResult> {
    const o = fields(input, ['query'])
    const query = o.query === undefined || o.query === null ? '' : o.query
    if (typeof query !== 'string' || query.length > QUERY_CHARS) {
      throw new Refusal(`query must be a text of at most ${QUERY_CHARS} characters.`)
    }
    const snapshot = await this.deps.read()
    const local = await this.deps.local()
    const ctx = this.context(snapshot, local)
    const facts = { ...snapshot.facts, ...local.facts }
    const words = query.trim()
    const rows = presentRows(ctx)
      .map(({ id, item }) => ({ id, item, entry: CATALOG[id] }))
      .filter((row) => !words || matchesWords(this.searchText(row, ctx), words))
    if (rows.length === 0) {
      return reply(
        `No setting matches "${words}". Try other words, or call find_settings without a query to list every row.`,
        { rows: [] },
      )
    }
    const full = words !== '' && rows.length <= MAX_FOUND
    const listed = rows.map((row) => this.describe(row, ctx, snapshot, facts, full))
    const lines: string[] = []
    let section: string | null = null
    for (const row of listed) {
      if (!full && row.section !== section) {
        section = row.section
        lines.push(`## ${row.sectionTitle}`)
      }
      lines.push(row.line)
    }
    const head = words
      ? `${rows.length} row${rows.length === 1 ? '' : 's'} match "${words}".`
      : `Every row of Kettu's Settings on this computer, by section.`
    return {
      content: [{ type: 'text', text: [head, ...lines].join('\n') }],
      structuredContent: { message: head, rows: listed.map((row) => row.found) },
    }
  }

  /** What search matches a row by: its words in the user's language and in English. */
  private searchText(row: Row, ctx: CatalogContext): string {
    const { entry } = row
    const parts: string[] = []
    for (const words of [this.deps.words, this.deps.english]) {
      parts.push(this.nameOf(row, ctx, words))
      const description = this.descriptionOf(row, ctx, words)
      if (description) parts.push(description)
      for (const key of keywordKeys(entry)) parts.push(words(key))
      parts.push(words(sectionTitle(entry.section)))
      if (entry.group) parts.push(words(entry.group))
    }
    const item = this.itemName(row, ctx)
    if (item) parts.push(item)
    return parts.join(' ')
  }

  private itemName(row: Row, ctx: CatalogContext): string | null {
    if (row.item === null) return null
    if (row.entry.item === 'plugin') {
      const id = row.item.slice(0, row.item.indexOf(':'))
      return ctx.plugins.find((plugin) => plugin.id === id)?.title ?? id
    }
    return (
      (row.entry.item === 'agent'
        ? ctx.agents.find((agent) => agent.id === row.item)?.name
        : ctx.harnesses.find((harness) => harness.id === row.item)?.name) ?? row.item
    )
  }

  /** A row's name: the plugin's own words for its settings, else the catalog's. */
  private nameOf(row: Row, ctx: CatalogContext, words: Words): string {
    return (
      literalWords(row.entry, ctx, row.item)?.name ??
      words(platformKey(row.entry.name, ctx.platform))
    )
  }

  private descriptionOf(row: Row, ctx: CatalogContext, words: Words): string | undefined {
    const literal = literalWords(row.entry, ctx, row.item)
    if (literal) return literal.description
    const { entry } = row
    return entry.description
      ? words(platformKey(entry.description, ctx.platform), entry.params?.(ctx.platform))
      : undefined
  }

  /** Where a card and its line put a row: its section and the item's page, without its group. */
  private section(row: Row, ctx: CatalogContext, words: Words): string {
    const item = this.itemName(row, ctx)
    const section = words(sectionTitle(row.entry.section))
    return item ? `${section} › ${item}` : section
  }

  /** Where a row is, its section, the item's page and its group, in `words`. */
  private place(row: Row, ctx: CatalogContext, words: Words): string {
    const parts = [words(sectionTitle(row.entry.section))]
    const item = this.itemName(row, ctx)
    if (item) parts.push(item)
    else if (row.entry.group) parts.push(words(row.entry.group))
    return parts.join(' › ')
  }

  /** The value the row holds now; undefined when the host could not read it. */
  private valueOf(
    row: Row,
    snapshot: SettingsSnapshot,
    facts: SettingFacts,
  ): SettingScalar | undefined {
    if (row.entry.get) return row.entry.get(snapshot.file, row.item)
    const fact = facts[toolId(row.id, row.item)]
    return fact === undefined ? undefined : fact
  }

  /** A value as the page writes it; a secret only as set or not, whatever the value. */
  private valueText(
    row: Row,
    value: SettingScalar | undefined,
    ctx: CatalogContext,
    words: Words,
  ): string {
    const { entry } = row
    if (entry.kind === 'secret') {
      return words(
        value === true || (typeof value === 'string' && value !== '')
          ? 'agentSettings.set'
          : 'agentSettings.notSet',
      )
    }
    if (value === undefined) return ''
    if (entry.kind === 'switch') return words(value ? 'agentSettings.on' : 'agentSettings.off')
    if (entry.kind === 'choice') {
      const option = optionsOf(entry, ctx, row.item).find((o) => sameValue(o.value, value))
      if (option) return this.label(option.label, ctx, words)
    }
    if (value === null || value === '') return words('agentSettings.notSet')
    if (typeof value === 'boolean') return words(value ? 'agentSettings.on' : 'agentSettings.off')
    return String(value)
  }

  private label(
    label: Parameters<typeof optionWords>[0],
    ctx: CatalogContext,
    words: Words,
  ): string {
    return (
      optionWords(label, ctx.platform) ??
      words('key' in label ? label.key : '', 'key' in label ? label.params : undefined)
    )
  }

  private access(
    row: Row,
    file: SettingsSnapshot['file'],
  ): { may: 'yes' | 'asks' | 'no'; how: string } {
    const { entry } = row
    if (changeable(entry) && !lockedNow(row.id, file)) {
      return entry.access === 'ask'
        ? {
            may: 'asks',
            how: 'you may change it when the user asks; it always asks the user in a card, in Full access too',
          }
        : {
            may: 'yes',
            how: 'you may change it when the user asks; it asks in a card unless this session is in Full access',
          }
    }
    switch (entry.kind) {
      case 'secret':
        return {
          may: 'no',
          how: 'a secret: only whether it is set; the user sets it on the page, open_settings takes them there',
        }
      case 'path':
        return {
          may: 'no',
          how: 'a path picked only in a system dialog; open_settings takes the user there',
        }
      case 'action':
        return {
          may: 'no',
          how: 'an action the user takes on the page; open_settings takes them there',
        }
      case 'list':
        return { may: 'no', how: 'a list: only its count here; open_settings takes the user to it' }
      default:
        return lockedNow(row.id, file)
          ? { may: 'no', how: 'it holds a password, so the user changes it on the page' }
          : {
              may: 'no',
              how: 'read only: the user changes it on the page, open_settings takes them there',
            }
    }
  }

  private describe(
    row: Row,
    ctx: CatalogContext,
    snapshot: SettingsSnapshot,
    facts: SettingFacts,
    full: boolean,
  ) {
    const { entry } = row
    const id = toolId(row.id, row.item)
    const t = this.deps.words
    const en = this.deps.english
    const name = this.nameOf(row, ctx, t)
    const english = this.nameOf(row, ctx, en)
    const place = this.place(row, ctx, t)
    const value = this.valueOf(row, snapshot, facts)
    const text = this.valueText(row, value, ctx, t)
    const access = this.access(row, snapshot.file)
    const takes =
      access.may === 'no'
        ? undefined
        : entry.kind === 'choice'
          ? optionsOf(entry, ctx, row.item).map((o) => ({
              value: o.value,
              label: this.label(o.label, ctx, t),
            }))
          : entry.kind === 'switch'
            ? [
                { value: true, label: t('agentSettings.on') },
                { value: false, label: t('agentSettings.off') },
              ]
            : undefined
    const description = full ? this.descriptionOf(row, ctx, t) : undefined
    // A secret's value, whatever the owner sent, goes out only as whether it is set.
    const shown = entry.kind === 'secret' ? undefined : value
    const bits = [
      text
        ? `value: ${text}${shown !== undefined && typeof shown !== 'boolean' && String(shown) !== text ? ` (${JSON.stringify(shown)})` : ''}`
        : entry.kind === 'action'
          ? null
          : 'value: not read here',
      takes && takes.length > 0
        ? `takes ${takes.map((o) => `${JSON.stringify(o.value)} (${o.label})`).join(', ')}`
        : entry.kind === 'number' && access.may !== 'no'
          ? `takes a whole number from ${entry.min} to ${entry.max}`
          : entry.kind === 'text' && access.may !== 'no'
            ? `takes a text of at most ${entry.chars} characters, "" to clear it`
            : null,
      access.how,
    ].filter((bit): bit is string => bit !== null)
    const englishPart = english !== name ? ` (${english})` : ''
    const line =
      `- ${id}: ${place} › ${name}${englishPart}` +
      (description ? `\n  ${description}` : '') +
      `\n  ${bits.join('; ')}`
    return {
      line,
      section: entry.section,
      sectionTitle: t(sectionTitle(entry.section)),
      found: {
        id,
        place,
        name,
        englishName: english,
        ...(description ? { description } : {}),
        ...(shown !== undefined ? { value: shown } : {}),
        ...(text ? { valueText: text } : {}),
        ...(takes ? { values: takes } : {}),
        change: access.may,
        access: access.how,
      },
    }
  }

  private async openRow(caller: Caller, input: unknown): Promise<CallToolResult> {
    const o = fields(input, ['id'])
    if (typeof o.id !== 'string' || o.id.length === 0 || o.id.length > ID_CHARS) {
      throw new Refusal('id must be a row id from find_settings.')
    }
    const snapshot = await this.deps.read()
    const local = await this.deps.local()
    const ctx = this.context(snapshot, local)
    const row = this.rowOf(o.id, ctx)
    if (!row)
      throw new Refusal(
        `There is no setting ${o.id} on this computer. Call find_settings for the rows.`,
      )
    const place = `${this.place(row, ctx, this.deps.words)} › ${this.nameOf(row, ctx, this.deps.words)}`
    const target = rowTarget(row.entry, row.item)
    const opened = this.deps.open(caller.sessionId, {
      section: row.entry.section,
      item: target.item,
      row: target.row,
      desktop: row.entry.part === 'desktop',
    })
    const text = opened
      ? `Opened Settings at ${place} in the window that shows this session.`
      : `No Kettu desktop window shows this session now, so nothing opened. Tell the user it is in Settings › ${place}.`
    return reply(text, { opened, place })
  }

  private async change(caller: Caller, input: unknown, deadline: number): Promise<CallToolResult> {
    const o = fields(input, ['changes'])
    const list = o.changes
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_CHANGES) {
      throw new Refusal(`changes must list from 1 to ${MAX_CHANGES} rows.`)
    }
    const asked: { id: string; value: unknown }[] = list.map((change, i) => {
      const c = fields(change, ['id', 'value'])
      if (typeof c.id !== 'string' || c.id.length === 0 || c.id.length > ID_CHARS) {
        throw new Refusal(`changes[${i}].id must be a row id from find_settings.`)
      }
      if (!('value' in c)) throw new Refusal(`changes[${i}].value is missing.`)
      if (typeof c.value === 'string' && c.value.length > VALUE_CHARS) {
        throw new Refusal(`changes[${i}].value is too long.`)
      }
      return { id: c.id, value: c.value }
    })
    const key = stable([...asked].sort((a, b) => a.id.localeCompare(b.id)))
    const waiting = this.jobs.get(caller.sessionId)?.find((job) => job.key === key)
    if (waiting) return this.follow(caller.sessionId, waiting, deadline)

    const snapshot = await this.deps.read()
    const local = await this.deps.local()
    const ctx = this.context(snapshot, local)
    const facts = { ...snapshot.facts, ...local.facts }
    const seen = new Set<string>()
    const items: { row: Row; to: SettingScalar; from: SettingScalar; item: SettingChangeItem }[] =
      []
    const problems: string[] = []
    const unchanged: string[] = []
    for (const change of asked) {
      const row = this.rowOf(change.id, ctx)
      if (!row) {
        problems.push(
          `${change.id}: there is no such setting on this computer; call find_settings for the rows.`,
        )
        continue
      }
      const id = toolId(row.id, row.item)
      if (seen.has(id)) {
        problems.push(`${id}: named twice.`)
        continue
      }
      seen.add(id)
      const place = this.place(row, ctx, this.deps.words)
      const name = this.nameOf(row, ctx, this.deps.words)
      if (!changeable(row.entry) || lockedNow(row.id, snapshot.file)) {
        problems.push(`${id} (${place} › ${name}): ${this.access(row, snapshot.file).how}.`)
        continue
      }
      const coerced = coerce(row.entry, ctx, row.item, change.value)
      if ('error' in coerced) {
        problems.push(`${id} (${place} › ${name}) ${coerced.error}.`)
        continue
      }
      const from = this.valueOf(row, snapshot, facts) ?? null
      if (sameValue(from, coerced.value)) {
        unchanged.push(`${place} › ${name}`)
        continue
      }
      const warning =
        row.entry.access === 'ask' && row.entry.warning
          ? this.deps.words(row.entry.warning)
          : undefined
      items.push({
        row,
        from,
        to: coerced.value,
        item: {
          id,
          place: this.section(row, ctx, this.deps.words),
          name,
          from: { value: from, text: this.valueText(row, from, ctx, this.deps.words) },
          to: {
            value: coerced.value,
            text: this.valueText(row, coerced.value, ctx, this.deps.words),
          },
          ...(warning ? { warning } : {}),
          section: row.entry.section,
          ...rowTarget(row.entry, row.item),
        },
      })
    }
    if (problems.length > 0) {
      throw new Refusal(['Nothing was changed:', ...problems].join('\n'))
    }
    if (items.length === 0) {
      return reply(
        `Nothing to change: ${unchanged.join(', ')} already ${unchanged.length === 1 ? 'has' : 'have'} that value.`,
        { changed: false },
      )
    }
    const already = unchanged.length > 0 ? ` ${unchanged.join(', ')} already had that value.` : ''
    const askAlways = items.some(({ row }) => row.entry.access === 'ask')
    if (this.deps.fullAccess(caller.sessionId) && !askAlways) {
      try {
        await this.applyItems(items, snapshot)
      } catch (error) {
        throw new Refusal(`Nothing was changed: ${(error as Error).message}`)
      }
      this.deps.recorded(
        caller.sessionId,
        items.map(({ item }) => item),
      )
      return changedResult(
        items.map(({ item }) => item),
        false,
        already,
      )
    }
    const card = this.deps.ask(caller.sessionId, { items: items.map(({ item }) => item) })
    if (!card) throw new Refusal('This session is not open, so it shows no card.')
    const job: CardJob = { key, count: items.length, confirmed: false, result: null! }
    job.result = card.answer.then((answer) => {
      job.confirmed = answer.decision === 'change'
      return this.answered(caller.sessionId, card.entryId, items, answer, already)
    })
    job.result.catch(() => {})
    this.jobs.set(caller.sessionId, [...(this.jobs.get(caller.sessionId) ?? []), job])
    return this.follow(caller.sessionId, job, deadline)
  }

  /** Applies what the user confirmed to the settings as they are then, or says why not. */
  private async answered(
    sessionId: string,
    entryId: string,
    items: { row: Row; to: SettingScalar; item: SettingChangeItem }[],
    answer: SettingsAnswer,
    already: string,
  ): Promise<CallToolResult> {
    if (answer.decision !== 'change') {
      const text =
        answer.decision === 'keep'
          ? "The user chose Don't change. Nothing changed; do not change these again unless they ask."
          : answer.decision === 'expired'
            ? 'The user did not answer within 10 minutes, so nothing changed.'
            : 'The turn ended before the user answered, so nothing changed.'
      return reply(text, { changed: false })
    }
    try {
      await this.applyItems(items, await this.deps.read())
    } catch (error) {
      const message = (error as Error).message
      this.deps.settle(sessionId, entryId, { kind: 'failed', message })
      throw new Refusal(`The user pressed Change, but Kettu could not apply it: ${message}`)
    }
    this.deps.settle(sessionId, entryId, { kind: 'changed' })
    return changedResult(
      items.map(({ item }) => item),
      true,
      already,
    )
  }

  /** The card's outcome once it has one, or by the deadline that the user has not answered yet. */
  private async follow(sessionId: string, job: CardJob, deadline: number): Promise<CallToolResult> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()))
    })
    try {
      const result = await Promise.race([job.result, late])
      if (result === null) return stillWaiting(job)
      this.done(sessionId, job)
      return result
    } catch (error) {
      this.done(sessionId, job)
      if (error instanceof Refusal) return failed(error.message)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private done(sessionId: string, job: CardJob): void {
    const left = (this.jobs.get(sessionId) ?? []).filter((other) => other !== job)
    if (left.length > 0) this.jobs.set(sessionId, left)
    else this.jobs.delete(sessionId)
  }
}

/** An undo refused because a row changed again since: its line no longer offers it. */
export class StaleUndo extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StaleUndo'
  }
}

function changedResult(
  items: SettingChangeItem[],
  asked: boolean,
  already: string,
): CallToolResult {
  const lines = items.map(
    (item) => `${item.place} › ${item.name}: ${item.from.text} → ${item.to.text}`,
  )
  const text =
    `${asked ? 'The user pressed Change. ' : ''}Changed ${lines.join('; ')}.${already} ` +
    'It takes effect at once; the thread shows a line the user can undo.'
  return reply(text, { changed: true, rows: items.map((item) => item.id) })
}

function stillWaiting(job: CardJob): CallToolResult {
  const rows = `${job.count} setting${job.count === 1 ? '' : 's'}`
  const text = job.confirmed
    ? `The user pressed Change and Kettu is applying it. Call change_settings again with the same changes for the outcome.`
    : `The user has not answered the card to change ${rows} yet, and nothing changed. Call change_settings again with the same changes to keep waiting on the same card; it shows no second one.`
  return reply(text, { waiting: true, confirmed: job.confirmed })
}
