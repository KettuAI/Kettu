// A plugin's `plugin.json`: the format's closed manifest, and Kettu's own entry under
// `extensions["sh.kettu"]`. An unknown top-level field is reported and ignored; anything else that
// does not fit refuses the whole package, with the reason.

import satisfies from 'semver/functions/satisfies'
import validRange from 'semver/ranges/valid'
import {
  PLUGIN_API_VERSIONS,
  PLUGIN_FORMAT,
  PLUGIN_NAME,
  PLUGIN_NAMESPACE,
  isPluginPermission,
  type PluginSetting,
  type PluginTexts,
} from '@shared/plugins'
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
  'views',
  'script',
  'api',
  'permissions',
])
const MAX_TEXT = 2_000
const MAX_LIST = 64
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/
const SETTING_KEY = /^[a-z][a-zA-Z0-9_]{0,63}$/
const SETTING_TYPES = ['boolean', 'string', 'select', 'secret'] as const

/** Kettu's entry of the manifest, at format 1. */
export interface KettuEntry {
  /** The Kettu versions it supports, as a semver range; null when it says none. */
  kettu: string | null
  titles: PluginTexts
  descriptions: PluginTexts
  settings: PluginSetting[]
  views: Record<string, unknown>[]
  /** The script's path inside the package, without the leading `./`; null without a script. */
  script: string | null
  api: number | null
  permissions: string[]
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
    if (typeof key !== 'string' || !SETTING_KEY.test(key) || keys.has(key)) {
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
  let views: Record<string, unknown>[] = []
  if (raw.views !== undefined) {
    if (!Array.isArray(raw.views) || raw.views.length > MAX_LIST || !raw.views.every(isRecord)) {
      throw badField(`${where}.views`)
    }
    views = raw.views as Record<string, unknown>[]
  }
  const entry: KettuEntry = {
    kettu: range,
    titles: texts(raw.title, `${where}.title`),
    descriptions: texts(raw.description, `${where}.description`),
    settings: settings(raw.settings, `${where}.settings`),
    views,
    script,
    api,
    permissions,
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
