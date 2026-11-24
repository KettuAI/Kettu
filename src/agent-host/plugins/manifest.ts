// A plugin's `plugin.json`: the format's closed manifest, and Kettu's own entry under
// `extensions["sh.kettu"]`. An unknown top-level field is reported and ignored; anything else that
// does not fit refuses the whole package, with the reason.

import satisfies from 'semver/functions/satisfies'
import validRange from 'semver/ranges/valid'
import {
  PLUGIN_API_VERSIONS,
  PLUGIN_FORMAT,
  PLUGIN_NAME,
  PLUGIN_HOOK_EVENTS,
  PLUGIN_NAMESPACE,
  PLUGIN_SETTING_KEY,
  PLUGIN_TOOL_LIMITS,
  PLUGIN_TOOL_NAME,
  isPluginHookEvent,
  isPluginPermission,
  type PluginSetting,
  type PluginTexts,
  type PluginTool,
  type PluginToolArgument,
} from '@shared/plugins'
import {
  isPluginViewIcon,
  isPluginViewKind,
  PLUGIN_ACTION_ID,
  PLUGIN_VIEW_ID,
  PLUGIN_VIEW_KINDS,
  PLUGIN_VIEW_LIMITS,
  type PluginActionDecl,
  type PluginViewDecl,
} from '@shared/plugin-views'
import {
  parseLinkPattern,
  patternHostAllowed,
  PLUGIN_REF_ID,
  PLUGIN_REF_LIMITS,
  type PluginLinkDecl,
  type PluginMentionDecl,
} from '@shared/plugin-refs'
import {
  PLUGIN_CHANNEL_ID,
  PLUGIN_CHANNEL_LIMITS,
  type PluginChannelDecl,
} from '@shared/plugin-channels'
import { HostError } from '../errors'
import { t } from '../i18n'

/** The format versions Kettu reads, by the `$schema` each manifest names. */
const SCHEMAS: Readonly<Record<string, string>> = {
  'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json': '1.0.0',
  'https://agent-plugins.org/schemas/1.1.0/plugin.schema.json': '1.1.0',
}
const TOP_LEVEL = new Set([
  '$schema',
  'name',
  'displayName',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions',
])
const KETTU_FIELDS = new Set([
  'format',
  'kettu',
  'title',
  'description',
  'settings',
  'tools',
  'views',
  'actions',
  'script',
  'api',
  'permissions',
  'events',
  'mentions',
  'links',
  'channels',
])
const MAX_TEXT = 2_000
const MAX_LIST = 64
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/
const SETTING_TYPES = ['boolean', 'string', 'select', 'secret'] as const
const VIEW_FIELDS = new Set(['id', 'kind', 'title', 'description', 'icon', 'pane'])
const ACTION_FIELDS = new Set(['id', 'title', 'description', 'icon'])
const MENTION_FIELDS = new Set(['id', 'title', 'icon'])
const LINK_FIELDS = new Set(['id', 'patterns', 'icon'])
const CHANNEL_FIELDS = new Set(['id', 'title', 'description'])

/** Kettu's entry of the manifest, at format 1. */
export interface KettuEntry {
  /** The Kettu versions it supports, as a semver range; null when it says none. */
  kettu: string | null
  titles: PluginTexts
  descriptions: PluginTexts
  settings: PluginSetting[]
  /** The tools it gives agents; left out unless the entry asks for the `tools` permission. */
  tools: PluginTool[]
  views: PluginViewDecl[]
  actions: PluginActionDecl[]
  /** The mention sources of the composer's `@` menu; left out unless the entry holds `prompt.attach`. */
  mentions: PluginMentionDecl[]
  /** The kinds of link in replies that the plugin draws as references. */
  links: PluginLinkDecl[]
  /** The script's path inside the package, without the leading `./`; null without a script. */
  script: string | null
  api: number | null
  permissions: string[]
  /** The Kettu events that wake the script; each is one `PLUGIN_HOOK_EVENTS` names. */
  events: string[]
  /** The notification channels it declares; its script is told the notices the user sends to one. */
  channels: PluginChannelDecl[]
}

export interface PluginManifest {
  /** The format version its `$schema` names. */
  spec: string
  name: string
  displayName: string | null
  version: string | null
  description: string
  author: string | null
  homepage: string | null
  repository: string | null
  license: string | null
  kettu: KettuEntry | null
  warnings: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Why a package is not installed, as the request's error. */
export function refusal(reason: string): HostError {
  return new HostError('invalid_params', t('plugins.invalid', { reason }))
}

function badField(field: string): HostError {
  return refusal(t('plugins.field', { field }))
}

function optionalText(o: Record<string, unknown>, key: string, where = key): string | null {
  const value = o[key]
  if (value === undefined) return null
  if (typeof value !== 'string' || value.length > MAX_TEXT) throw badField(where)
  return value
}

/**
 * A path a manifest names inside the package: `./` and parts with `/` between them, none of them
 * empty, `.` or `..`. Returns it without the `./`, or null when it could leave the package.
 */
export function packagePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('./') || value.length > 512) return null
  const inner = value.slice(2)
  if (inner === '' || /[\\\0]/.test(inner)) return null
  const parts = inner.split('/')
  return parts.every((part) => part !== '' && part !== '.' && part !== '..') ? inner : null
}

function texts(value: unknown, field: string): PluginTexts {
  if (value === undefined) return {}
  if (typeof value === 'string') {
    if (value.length > MAX_TEXT) throw badField(field)
    return { en: value }
  }
  if (!isRecord(value)) throw badField(field)
  const out: PluginTexts = {}
  for (const [language, text] of Object.entries(value)) {
    if (!LANGUAGE.test(language) || typeof text !== 'string' || text.length > MAX_TEXT) {
      throw badField(`${field}.${language}`)
    }
    out[language] = text
  }
  return out
}

function settings(value: unknown, field: string): PluginSetting[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_LIST) throw badField(field)
  const keys = new Set<string>()
  return value.map((raw: unknown, index): PluginSetting => {
    const at = `${field}[${index}]`
    if (!isRecord(raw)) throw badField(at)
    const { key, type, options } = raw
    if (typeof key !== 'string' || !PLUGIN_SETTING_KEY.test(key) || keys.has(key)) {
      throw badField(`${at}.key`)
    }
    keys.add(key)
    if (!(SETTING_TYPES as readonly unknown[]).includes(type)) throw badField(`${at}.type`)
    const title = optionalText(raw, 'title', `${at}.title`)
    if (title === null || title.trim() === '') throw badField(`${at}.title`)
    const description = optionalText(raw, 'description', `${at}.description`)
    const fallback = raw.default
    const wanted = type === 'boolean' ? 'boolean' : 'string'
    // A secret has no default: its value only ever lives in the key store.
    if (fallback !== undefined && (typeof fallback !== wanted || type === 'secret')) {
      throw badField(`${at}.default`)
    }
    const setting: PluginSetting = { key, type: type as PluginSetting['type'], title }
    if (description !== null) setting.description = description
    if (fallback !== undefined) setting.default = fallback as string | boolean
    if (type === 'select') {
      if (!Array.isArray(options) || options.length === 0 || options.length > MAX_LIST) {
        throw badField(`${at}.options`)
      }
      setting.options = options.map((option: unknown, n) => {
        if (
          !isRecord(option) ||
          typeof option.value !== 'string' ||
          typeof option.title !== 'string' ||
          option.value.length > MAX_TEXT ||
          option.title.length > MAX_TEXT
        ) {
          throw badField(`${at}.options[${n}]`)
        }
        return { value: option.value, title: option.title }
      })
    } else if (options !== undefined) {
      throw badField(`${at}.options`)
    }
    return setting
  })
}

/**
 * The views a manifest declares. An unknown kind is refused, since the script's data would not be
 * drawn; a field or an icon a later Kettu may add is passed over with a warning.
 */
export function parseViews(value: unknown, where: string, warnings: string[]): PluginViewDecl[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > PLUGIN_VIEW_LIMITS.views) throw badField(where)
  const ids = new Set<string>()
  return value.map((raw: unknown, index): PluginViewDecl => {
    const at = `${where}[${index}]`
    if (!isRecord(raw)) throw badField(at)
    const { id, kind } = raw
    if (typeof id !== 'string' || !PLUGIN_VIEW_ID.test(id) || ids.has(id)) {
      throw badField(`${at}.id`)
    }
    ids.add(id)
    if (!isPluginViewKind(kind)) {
      throw refusal(
        t('plugins.viewKind', {
          id,
          kind: String(kind).slice(0, 40),
          kinds: PLUGIN_VIEW_KINDS.join(', '),
        }),
      )
    }
    for (const key of Object.keys(raw)) {
      if (!VIEW_FIELDS.has(key)) {
        warnings.push(t('plugins.warn.viewField', { view: id, field: key.slice(0, 100) }))
      }
    }
    const title = texts(raw.title, `${at}.title`)
    if (Object.values(title).every((text) => text.trim() === '')) throw badField(`${at}.title`)
    const decl: PluginViewDecl = { id, kind, title }
    const description = texts(raw.description, `${at}.description`)
    if (Object.keys(description).length > 0) decl.description = description
    if (raw.icon !== undefined) {
      if (isPluginViewIcon(raw.icon)) decl.icon = raw.icon
      else warnings.push(t('plugins.warn.viewIcon', { view: id }))
    }
    if (raw.pane !== undefined) {
      if (typeof raw.pane !== 'boolean') throw badField(`${at}.pane`)
      if (raw.pane) decl.pane = true
    }
    return decl
  })
}

/** A text by language whose every language is within `max`. */
function shortTexts(value: unknown, field: string, max: number): PluginTexts {
  const out = texts(value, field)
  for (const [language, text] of Object.entries(out)) {
    if (text.length > max) throw badField(`${field}.${language}`)
  }
  return out
}

/**
 * The actions a manifest declares for Search. Each has a title in at least one language, and an
 * icon or a field a later Kettu may add is passed over with a warning.
 */
export function parseActions(
  value: unknown,
  where: string,
  warnings: string[],
): PluginActionDecl[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > PLUGIN_VIEW_LIMITS.searchActions) {
    throw badField(where)
  }
  const ids = new Set<string>()
  return value.map((raw: unknown, index): PluginActionDecl => {
    const at = `${where}[${index}]`
    if (!isRecord(raw)) throw badField(at)
    const { id } = raw
    if (typeof id !== 'string' || !PLUGIN_ACTION_ID.test(id) || ids.has(id)) {
      throw badField(`${at}.id`)
    }
    ids.add(id)
    for (const key of Object.keys(raw)) {
      if (!ACTION_FIELDS.has(key)) {
        warnings.push(t('plugins.warn.actionField', { action: id, field: key.slice(0, 100) }))
      }
    }
    const title = shortTexts(raw.title, `${at}.title`, PLUGIN_VIEW_LIMITS.actionLabel)
    if (Object.values(title).every((text) => text.trim() === '')) throw badField(`${at}.title`)
    const decl: PluginActionDecl = { id, title }
    const description = shortTexts(
      raw.description,
      `${at}.description`,
      PLUGIN_VIEW_LIMITS.actionDescription,
    )
    if (Object.keys(description).length > 0) decl.description = description
    if (raw.icon !== undefined) {
      if (isPluginViewIcon(raw.icon)) decl.icon = raw.icon
      else warnings.push(t('plugins.warn.actionIcon', { action: id }))
    }
    return decl
  })
}

/** The mention sources a manifest declares: an id, a title by language and optionally an icon. */
export function parseMentions(
  value: unknown,
  where: string,
  warnings: string[],
): PluginMentionDecl[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > PLUGIN_REF_LIMITS.mentions) throw badField(where)
  const ids = new Set<string>()
  return value.map((raw: unknown, index): PluginMentionDecl => {
    const at = `${where}[${index}]`
    if (!isRecord(raw)) throw badField(at)
    const { id } = raw
    if (typeof id !== 'string' || !PLUGIN_REF_ID.test(id) || ids.has(id)) {
      throw badField(`${at}.id`)
    }
    ids.add(id)
    for (const key of Object.keys(raw)) {
      if (!MENTION_FIELDS.has(key)) {
        warnings.push(t('plugins.warn.refField', { id, field: key.slice(0, 100) }))
      }
    }
    const title = texts(raw.title, `${at}.title`)
    if (Object.values(title).every((text) => text.trim() === '')) throw badField(`${at}.title`)
    const decl: PluginMentionDecl = { id, title }
    if (raw.icon !== undefined) {
      if (isPluginViewIcon(raw.icon)) decl.icon = raw.icon
      else warnings.push(t('plugins.warn.refIcon', { id }))
    }
    return decl
  })
}

/**
 * The kinds of link a manifest declares. A pattern that is not one is refused, and so is one on a
 * host the plugin has no network permission for, since a plugin only hears of addresses on hosts
 * it may connect to.
 */
export function parseLinks(
  value: unknown,
  where: string,
  permissions: readonly string[],
  warnings: string[],
): PluginLinkDecl[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > PLUGIN_REF_LIMITS.links) throw badField(where)
  const ids = new Set<string>()
  return value.map((raw: unknown, index): PluginLinkDecl => {
    const at = `${where}[${index}]`
    if (!isRecord(raw)) throw badField(at)
    const { id, patterns } = raw
    if (typeof id !== 'string' || !PLUGIN_REF_ID.test(id) || ids.has(id)) {
      throw badField(`${at}.id`)
    }
    ids.add(id)
    for (const key of Object.keys(raw)) {
      if (!LINK_FIELDS.has(key)) {
        warnings.push(t('plugins.warn.refField', { id, field: key.slice(0, 100) }))
      }
    }
    if (
      !Array.isArray(patterns) ||
      patterns.length === 0 ||
      patterns.length > PLUGIN_REF_LIMITS.patterns
    ) {
      throw badField(`${at}.patterns`)
    }
    const list = patterns.map((text: unknown, n) => {
      const pattern = typeof text === 'string' ? parseLinkPattern(text) : null
      if (typeof text !== 'string' || pattern === null) throw badField(`${at}.patterns[${n}]`)
      if (!patternHostAllowed(pattern, permissions)) {
        throw refusal(t('plugins.linkHost', { pattern: text.slice(0, 200), host: pattern.host }))
      }
      return text
    })
    const decl: PluginLinkDecl = { id, patterns: [...new Set(list)] }
    if (raw.icon !== undefined) {
      if (isPluginViewIcon(raw.icon)) decl.icon = raw.icon
      else warnings.push(t('plugins.warn.refIcon', { id }))
    }
    return decl
  })
}

/** The notification channels a manifest declares; a field a later Kettu may add is passed over. */
export function parseChannels(
  value: unknown,
  where: string,
  warnings: string[],
): PluginChannelDecl[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > PLUGIN_CHANNEL_LIMITS.channels) {
    throw badField(where)
  }
  const ids = new Set<string>()
  return value.map((raw: unknown, index): PluginChannelDecl => {
    const at = `${where}[${index}]`
    if (!isRecord(raw)) throw badField(at)
    const { id } = raw
    if (typeof id !== 'string' || !PLUGIN_CHANNEL_ID.test(id) || ids.has(id)) {
      throw badField(`${at}.id`)
    }
    ids.add(id)
    for (const key of Object.keys(raw)) {
      if (!CHANNEL_FIELDS.has(key)) {
        warnings.push(t('plugins.warn.channelField', { channel: id, field: key.slice(0, 100) }))
      }
    }
    const title = shortTexts(raw.title, `${at}.title`, PLUGIN_CHANNEL_LIMITS.title)
    if (Object.values(title).every((text) => text.trim() === '')) throw badField(`${at}.title`)
    const decl: PluginChannelDecl = { id, title }
    const description = shortTexts(
      raw.description,
      `${at}.description`,
      PLUGIN_CHANNEL_LIMITS.description,
    )
    if (Object.keys(description).length > 0) decl.description = description
    return decl
  })
}

const TOOL_ARGUMENT_TYPES = ['string', 'number', 'integer', 'boolean'] as const

function toolArgument(raw: unknown, at: string): PluginToolArgument {
  if (!isRecord(raw)) throw badField(at)
  const type = (TOOL_ARGUMENT_TYPES as readonly unknown[]).includes(raw.type)
    ? (raw.type as PluginToolArgument['type'])
    : null
  if (type === null) throw badField(`${at}.type`)
  for (const key of Object.keys(raw)) {
    if (!['type', 'description', 'enum', 'minimum', 'maximum'].includes(key)) {
      throw badField(`${at}.${key.slice(0, 100)}`)
    }
  }
  const argument: PluginToolArgument = { type }
  const description = optionalText(raw, 'description', `${at}.description`)
  if (description !== null) argument.description = description
  if (raw.enum !== undefined) {
    const values = raw.enum
    if (
      type !== 'string' ||
      !Array.isArray(values) ||
      values.length === 0 ||
      values.length > PLUGIN_TOOL_LIMITS.enumValues ||
      !values.every(
        (value) => typeof value === 'string' && value.length <= PLUGIN_TOOL_LIMITS.enumChars,
      )
    ) {
      throw badField(`${at}.enum`)
    }
    argument.enum = values as string[]
  }
  for (const bound of ['minimum', 'maximum'] as const) {
    const value = raw[bound]
    if (value === undefined) continue
    if (
      type === 'string' ||
      type === 'boolean' ||
      typeof value !== 'number' ||
      !Number.isFinite(value)
    ) {
      throw badField(`${at}.${bound}`)
    }
    argument[bound] = value
  }
  return argument
}

/** The tools a plugin gives agents: a name, a description and the arguments each takes. */
function tools(value: unknown, field: string): PluginTool[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > PLUGIN_TOOL_LIMITS.tools) throw badField(field)
  const names = new Set<string>()
  return value.map((raw: unknown, index): PluginTool => {
    const at = `${field}[${index}]`
    if (!isRecord(raw)) throw badField(at)
    const { name, inputSchema } = raw
    if (typeof name !== 'string' || !PLUGIN_TOOL_NAME.test(name) || names.has(name)) {
      throw badField(`${at}.name`)
    }
    names.add(name)
    const description = optionalText(raw, 'description', `${at}.description`)
    if (
      description === null ||
      description.trim() === '' ||
      description.length > PLUGIN_TOOL_LIMITS.description
    ) {
      throw badField(`${at}.description`)
    }
    const properties: Record<string, PluginToolArgument> = {}
    let required: string[] = []
    if (inputSchema !== undefined) {
      if (!isRecord(inputSchema) || inputSchema.type !== 'object') {
        throw badField(`${at}.inputSchema`)
      }
      for (const key of Object.keys(inputSchema)) {
        if (!['type', 'properties', 'required', 'additionalProperties'].includes(key)) {
          throw badField(`${at}.inputSchema.${key.slice(0, 100)}`)
        }
      }
      if (
        inputSchema.additionalProperties !== undefined &&
        inputSchema.additionalProperties !== false
      ) {
        throw badField(`${at}.inputSchema.additionalProperties`)
      }
      const declared = inputSchema.properties ?? {}
      if (!isRecord(declared) || Object.keys(declared).length > PLUGIN_TOOL_LIMITS.arguments) {
        throw badField(`${at}.inputSchema.properties`)
      }
      for (const [key, argument] of Object.entries(declared)) {
        if (!PLUGIN_SETTING_KEY.test(key))
          throw badField(`${at}.inputSchema.properties.${key.slice(0, 100)}`)
        properties[key] = toolArgument(argument, `${at}.inputSchema.properties.${key}`)
      }
      if (inputSchema.required !== undefined) {
        const list = inputSchema.required
        if (
          !Array.isArray(list) ||
          !list.every((key) => typeof key === 'string' && Object.hasOwn(properties, key))
        ) {
          throw badField(`${at}.inputSchema.required`)
        }
        required = [...new Set(list as string[])]
      }
    }
    return {
      name,
      description,
      inputSchema: {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      },
    }
  })
}

function kettuEntry(raw: Record<string, unknown>, appVersion: string, warnings: string[]) {
  const where = `extensions["${PLUGIN_NAMESPACE}"]`
  const { format } = raw
  if (typeof format !== 'number' || !Number.isInteger(format) || format < 1) {
    throw badField(`${where}.format`)
  }
  if (format !== PLUGIN_FORMAT) {
    throw refusal(t('plugins.format', { version: format, reads: PLUGIN_FORMAT }))
  }
  // A version of the format only ever adds fields, so one this app does not know is passed over.
  for (const key of Object.keys(raw)) {
    if (!KETTU_FIELDS.has(key)) warnings.push(t('plugins.warn.kettuField', { field: key }))
  }
  const range = optionalText(raw, 'kettu', `${where}.kettu`)
  if (range !== null) {
    if (validRange(range) === null) throw badField(`${where}.kettu`)
    if (!satisfies(appVersion, range, { includePrerelease: true })) {
      throw refusal(t('plugins.kettuVersion', { range, version: appVersion }))
    }
  }
  let script: string | null = null
  if (raw.script !== undefined) {
    script = packagePath(raw.script)
    if (script === null) throw badField(`${where}.script`)
  }
  let api: number | null = null
  if (raw.api !== undefined) {
    if (typeof raw.api !== 'number' || !Number.isInteger(raw.api)) throw badField(`${where}.api`)
    api = raw.api
  }
  if (script !== null) {
    if (api === null) throw badField(`${where}.api`)
    if (!PLUGIN_API_VERSIONS.includes(api)) throw refusal(t('plugins.api', { version: api }))
  }
  const permissions: string[] = []
  if (raw.permissions !== undefined) {
    if (!Array.isArray(raw.permissions) || raw.permissions.length > MAX_LIST) {
      throw badField(`${where}.permissions`)
    }
    for (const permission of raw.permissions as unknown[]) {
      if (typeof permission !== 'string') throw badField(`${where}.permissions`)
      if (!isPluginPermission(permission)) {
        throw refusal(t('plugins.permission', { permission: permission.slice(0, 200) }))
      }
      if (!permissions.includes(permission)) permissions.push(permission)
    }
  }
  const events: string[] = []
  if (raw.events !== undefined) {
    if (!Array.isArray(raw.events) || raw.events.length > MAX_LIST) {
      throw badField(`${where}.events`)
    }
    for (const event of raw.events as unknown[]) {
      if (typeof event !== 'string') throw badField(`${where}.events`)
      // A later Kettu may know more events; this one passes over them.
      if (!isPluginHookEvent(event)) {
        warnings.push(t('plugins.warn.event', { event: event.slice(0, 100) }))
      } else if (!permissions.includes(PLUGIN_HOOK_EVENTS[event])) {
        warnings.push(
          t('plugins.warn.eventPermission', { event, permission: PLUGIN_HOOK_EVENTS[event] }),
        )
      } else if (!events.includes(event)) {
        events.push(event)
      }
    }
  }
  const views = parseViews(raw.views, `${where}.views`, warnings)
  if (views.length > 0 && script === null) {
    throw refusal(t('plugins.viewsNeedScript', { view: views[0]!.id }))
  }
  let toolList = tools(raw.tools, `${where}.tools`)
  if (toolList.length > 0 && !permissions.includes('tools')) {
    warnings.push(t('plugins.warn.toolsPermission'))
    toolList = []
  }
  if (toolList.length > 0 && script === null) throw badField(`${where}.script`)
  const actions = parseActions(raw.actions, `${where}.actions`, warnings)
  let mentionList = parseMentions(raw.mentions, `${where}.mentions`, warnings)
  if (mentionList.length > 0 && !permissions.includes('prompt.attach')) {
    warnings.push(t('plugins.warn.mentionsPermission'))
    mentionList = []
  }
  const linkList = parseLinks(raw.links, `${where}.links`, permissions, warnings)
  if (actions.length > 0 && script === null) {
    throw refusal(t('plugins.actionsNeedScript', { action: actions[0]!.id }))
  }
  if ((mentionList.length > 0 || linkList.length > 0) && script === null) {
    throw badField(`${where}.script`)
  }
  const channels = parseChannels(raw.channels, `${where}.channels`, warnings)
  if (channels.length > 0 && script === null) {
    throw refusal(t('plugins.channelsNeedScript', { channel: channels[0]!.id }))
  }
  const entry: KettuEntry = {
    kettu: range,
    titles: texts(raw.title, `${where}.title`),
    descriptions: texts(raw.description, `${where}.description`),
    settings: settings(raw.settings, `${where}.settings`),
    tools: toolList,
    views,
    actions,
    mentions: mentionList,
    links: linkList,
    script,
    api,
    permissions,
    events,
    channels,
  }
  return entry
}

/**
 * Reads a `plugin.json`. Throws with the reason when the manifest, or Kettu's entry in it, is
 * not one this app installs; `appVersion` is checked against the Kettu versions the entry names.
 */
export function parseManifest(text: string, appVersion: string): PluginManifest {
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    throw refusal(t('plugins.notJson'))
  }
  if (!isRecord(raw)) throw refusal(t('plugins.notJson'))
  const warnings: string[] = []
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL.has(key)) {
      warnings.push(t('plugins.warn.unknownField', { field: key.slice(0, 100) }))
    }
  }
  const schema = raw.$schema
  if (typeof schema !== 'string') throw badField('$schema')
  const spec = SCHEMAS[schema]
  if (spec === undefined) throw refusal(t('plugins.schema', { schema: schema.slice(0, 200) }))
  const { name } = raw
  if (typeof name !== 'string' || !PLUGIN_NAME.test(name)) throw badField('name')
  // `displayName` came with 1.1.0; in a 1.0.0 manifest it is an unknown field.
  let displayName: string | null = null
  if (spec === '1.0.0') {
    if (raw.displayName !== undefined) {
      warnings.push(t('plugins.warn.unknownField', { field: 'displayName' }))
    }
  } else {
    displayName = optionalText(raw, 'displayName')
  }
  let author: string | null = null
  if (raw.author !== undefined) {
    if (!isRecord(raw.author)) throw badField('author')
    for (const [key, value] of Object.entries(raw.author)) {
      if (!['name', 'email', 'url'].includes(key) || typeof value !== 'string') {
        throw badField(`author.${key.slice(0, 100)}`)
      }
    }
    author = optionalText(raw.author, 'name', 'author.name')
  }
  if (raw.keywords !== undefined) {
    const { keywords } = raw
    if (!Array.isArray(keywords) || !keywords.every((word) => typeof word === 'string')) {
      throw badField('keywords')
    }
  }
  let kettu: KettuEntry | null = null
  if (raw.extensions !== undefined) {
    if (!isRecord(raw.extensions)) {
      warnings.push(t('plugins.warn.extensions'))
    } else {
      const own = raw.extensions[PLUGIN_NAMESPACE]
      if (own !== undefined) {
        if (!isRecord(own)) throw badField(`extensions["${PLUGIN_NAMESPACE}"]`)
        kettu = kettuEntry(own, appVersion, warnings)
      }
    }
  }
  return {
    spec,
    name,
    displayName: displayName?.trim() || null,
    version: optionalText(raw, 'version'),
    description: optionalText(raw, 'description') ?? '',
    author,
    homepage: optionalText(raw, 'homepage'),
    repository: optionalText(raw, 'repository'),
    license: optionalText(raw, 'license'),
    kettu,
    warnings,
  }
}
