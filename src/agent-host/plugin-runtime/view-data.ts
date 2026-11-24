// What a plugin's script answers for a view or an action, checked and cut to the format's limits
// before any window sees it. A shape that does not fit is refused with the path of the field; a
// field this Kettu does not know is dropped, since a version of the format only ever adds fields.

import {
  isPluginViewIcon,
  PLUGIN_ACTION_ID,
  PLUGIN_FIELD_KEY,
  PLUGIN_VIEW_ID,
  PLUGIN_VIEW_LIMITS as LIMITS,
  PLUGIN_VIEW_PARAM_KEY,
  PLUGIN_VIEW_TONES,
  type PluginActionsContent,
  type PluginDetailContent,
  type PluginFormContent,
  type PluginFormField,
  type PluginFormValues,
  type PluginListContent,
  type PluginViewAction,
  type PluginViewActionResult,
  type PluginViewBadge,
  type PluginViewContent,
  type PluginViewKind,
  type PluginViewParams,
  type PluginViewRow,
} from '@shared/plugin-views'

/** A shape the format does not allow; its message names the field. */
export class ViewDataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ViewDataError'
  }
}

/** What a view's data may point at: the ids of the plugin's declared views. */
export interface ViewCheck {
  views: ReadonlySet<string>
}

export type Raw = Record<string, unknown>

export function bad(path: string, what: string): never {
  throw new ViewDataError(`${path} ${what}`)
}

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function at(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`
}

export function record(value: unknown, path: string): Raw {
  if (!isRecord(value)) return bad(path, 'must be an object')
  return value
}

export function array(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) return bad(path, 'must be a list')
  if (value.length > max) return bad(path, `has more than ${max} items`)
  return value
}

/** A text that may be left out, cut at `max`. */
export function optionalText(o: Raw, key: string, path: string, max: number): string | undefined {
  const value = o[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return bad(at(path, key), 'must be text')
  return value.slice(0, max)
}

/** A text that must be there and show something, cut at `max`. */
export function requiredText(o: Raw, key: string, path: string, max: number): string {
  const value = optionalText(o, key, path, max)
  if (value === undefined || value.trim() === '') return bad(at(path, key), 'must be text')
  return value
}

function optionalFlag(o: Raw, key: string, path: string): boolean | undefined {
  const value = o[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') return bad(at(path, key), 'must be true or false')
  return value
}

/** An icon of the fixed set; one that is not in it is left out, since it only decorates. */
export function icon(o: Raw): { icon?: PluginViewRow['icon'] } {
  return isPluginViewIcon(o.icon) ? { icon: o.icon } : {}
}

export function set<T extends object>(out: T, key: string, value: unknown): void {
  if (value !== undefined) (out as Record<string, unknown>)[key] = value
}

/** The parameters a view is opened with. */
export function parseParams(value: unknown, path: string): PluginViewParams {
  if (value === undefined || value === null) return {}
  const o = record(value, path)
  const keys = Object.keys(o)
  if (keys.length > LIMITS.params) return bad(path, `has more than ${LIMITS.params} entries`)
  const out: PluginViewParams = {}
  for (const key of keys) {
    if (!PLUGIN_VIEW_PARAM_KEY.test(key)) return bad(`${path}.${key.slice(0, 40)}`, 'is not a name')
    const item = o[key]
    if (typeof item !== 'string') return bad(`${path}.${key}`, 'must be text')
    out[key] = item.slice(0, LIMITS.paramValue)
  }
  return out
}

function parseAction(value: unknown, path: string, check: ViewCheck): PluginViewAction {
  const o = record(value, path)
  const { id } = o
  if (typeof id !== 'string' || !PLUGIN_ACTION_ID.test(id)) return bad(`${path}.id`, 'is not an id')
  const action: PluginViewAction = {
    id,
    label: requiredText(o, 'label', path, LIMITS.actionLabel),
    ...icon(o),
  }
  set(action, 'description', optionalText(o, 'description', path, LIMITS.actionDescription))
  set(action, 'confirm', optionalText(o, 'confirm', path, LIMITS.confirm))
  for (const key of ['primary', 'destructive', 'disabled'] as const) {
    const flag = optionalFlag(o, key, path)
    if (flag === true) action[key] = true
  }
  if (o.open !== undefined && o.open !== null) {
    const open = record(o.open, `${path}.open`)
    const view = open.view
    if (typeof view !== 'string' || !PLUGIN_VIEW_ID.test(view) || !check.views.has(view)) {
      return bad(`${path}.open.view`, 'is not a view of this plugin')
    }
    const params = parseParams(open.params, `${path}.open.params`)
    action.open = Object.keys(params).length > 0 ? { view, params } : { view }
  }
  return action
}

function parseActions(
  value: unknown,
  path: string,
  max: number,
  check: ViewCheck,
): PluginViewAction[] | undefined {
  if (value === undefined || value === null) return undefined
  const actions = array(value, path, max).map((item, i) =>
    parseAction(item, `${path}[${i}]`, check),
  )
  const ids = new Set<string>()
  for (const [i, action] of actions.entries()) {
    if (ids.has(action.id)) return bad(`${path}[${i}].id`, 'is used by another action')
    ids.add(action.id)
  }
  if (actions.filter((action) => action.primary).length > 1) {
    return bad(path, 'has more than one primary action')
  }
  return actions
}

export function parseBadges(value: unknown, path: string): PluginViewBadge[] | undefined {
  if (value === undefined || value === null) return undefined
  return array(value, path, LIMITS.badges).map((item, i) => {
    const o = record(item, `${path}[${i}]`)
    const badge: PluginViewBadge = {
      text: requiredText(o, 'text', `${path}[${i}]`, LIMITS.badgeText),
    }
    // A tone that is not in the set draws as neutral, like one left out.
    if ((PLUGIN_VIEW_TONES as readonly unknown[]).includes(o.tone)) {
      badge.tone = o.tone as PluginViewBadge['tone']
    }
    return badge
  })
}

function parseScope(value: unknown, path: string): string[] | undefined {
  if (value === undefined || value === null) return undefined
  return array(value, path, LIMITS.scope).map((item, i) => {
    if (typeof item !== 'string') return bad(`${path}[${i}]`, 'must be text')
    return item.slice(0, LIMITS.scopePart)
  })
}

/** What every kind may carry: its scope and the buttons at its foot. */
function common(o: Raw, check: ViewCheck): { scope?: string[]; actions?: PluginViewAction[] } {
  const out: { scope?: string[]; actions?: PluginViewAction[] } = {}
  set(out, 'scope', parseScope(o.scope, 'scope'))
  set(out, 'actions', parseActions(o.actions, 'actions', LIMITS.actions, check))
  return out
}

function parseRows(
  value: unknown,
  check: ViewCheck,
): { rows: PluginViewRow[]; truncated: boolean } {
  if (!Array.isArray(value)) return bad('rows', 'must be a list')
  const given = value.slice(0, LIMITS.rows)
  const ids = new Set<string>()
  const rows = given.map((item, i): PluginViewRow => {
    const path = `rows[${i}]`
    const o = record(item, path)
    const { id } = o
    if (typeof id !== 'string' || id === '' || id.length > LIMITS.rowId) {
      return bad(`${path}.id`, `must be text of 1 to ${LIMITS.rowId} characters`)
    }
    if (ids.has(id)) return bad(`${path}.id`, 'is used by another row')
    ids.add(id)
    const row: PluginViewRow = {
      id,
      title: requiredText(o, 'title', path, LIMITS.title),
      ...icon(o),
    }
    set(row, 'subtitle', optionalText(o, 'subtitle', path, LIMITS.subtitle))
    if (optionalFlag(o, 'mono', path)) row.mono = true
    set(row, 'badges', parseBadges(o.badges, `${path}.badges`))
    set(row, 'end', optionalText(o, 'end', path, LIMITS.end))
    set(row, 'actions', parseActions(o.actions, `${path}.actions`, LIMITS.rowActions, check))
    return row
  })
  return { rows, truncated: value.length > given.length }
}

function parseList(o: Raw, check: ViewCheck): PluginListContent {
  const { rows, truncated } = parseRows(o.rows, check)
  const content: PluginListContent = { kind: 'list', ...common(o, check), rows }
  if (truncated) content.truncated = true
  if (o.empty !== undefined && o.empty !== null) {
    const empty = record(o.empty, 'empty')
    const out: { title: string; description?: string } = {
      title: requiredText(empty, 'title', 'empty', LIMITS.emptyTitle),
    }
    set(out, 'description', optionalText(empty, 'description', 'empty', LIMITS.emptyDescription))
    content.empty = out
  }
  return content
}

function parseDetail(o: Raw, check: ViewCheck): PluginDetailContent {
  const content: PluginDetailContent = { kind: 'detail', ...common(o, check), ...icon(o) }
  set(content, 'title', optionalText(o, 'title', '', LIMITS.title))
  set(content, 'subtitle', optionalText(o, 'subtitle', '', LIMITS.subtitle))
  set(content, 'badges', parseBadges(o.badges, 'badges'))
  set(content, 'body', optionalText(o, 'body', '', LIMITS.body))
  if (o.fields !== undefined && o.fields !== null) {
    content.fields = array(o.fields, 'fields', LIMITS.fields).map((item, i) => {
      const path = `fields[${i}]`
      const field = record(item, path)
      const out: { label: string; value: string; mono?: true } = {
        label: requiredText(field, 'label', path, LIMITS.fieldLabel),
        value: optionalText(field, 'value', path, LIMITS.fieldValue) ?? '',
      }
      if (optionalFlag(field, 'mono', path)) out.mono = true
      return out
    })
  }
  return content
}

function parseField(value: unknown, i: number, keys: Set<string>): PluginFormField {
  const path = `fields[${i}]`
  const o = record(value, path)
  const { key, type } = o
  if (typeof key !== 'string' || !PLUGIN_FIELD_KEY.test(key))
    return bad(`${path}.key`, 'is not a name')
  if (keys.has(key)) return bad(`${path}.key`, 'is used by another field')
  keys.add(key)
  const base: { key: string; label: string; description?: string } = {
    key,
    label: requiredText(o, 'label', path, LIMITS.formLabel),
  }
  set(base, 'description', optionalText(o, 'description', path, LIMITS.formDescription))
  if (type === 'switch') {
    return { ...base, type, value: optionalFlag(o, 'value', path) ?? false }
  }
  if (type === 'choice') {
    const options = array(o.options, `${path}.options`, LIMITS.options).map((item, n) => {
      const option = record(item, `${path}.options[${n}]`)
      return {
        value: requiredText(option, 'value', `${path}.options[${n}]`, LIMITS.optionValue),
        label: requiredText(option, 'label', `${path}.options[${n}]`, LIMITS.formLabel),
      }
    })
    if (options.length === 0) return bad(`${path}.options`, 'must have a choice')
    const given = o.value
    if (given !== undefined && given !== null) {
      if (typeof given !== 'string' || !options.some((option) => option.value === given)) {
        return bad(`${path}.value`, 'is not one of the options')
      }
    }
    return { ...base, type, options, value: (given as string | undefined) ?? options[0]!.value }
  }
  if (type === 'text') {
    const rawMax = o.maxLength
    if (rawMax !== undefined && rawMax !== null) {
      if (typeof rawMax !== 'number' || !Number.isInteger(rawMax) || rawMax < 1) {
        return bad(`${path}.maxLength`, 'must be a whole number from 1')
      }
    }
    const maxLength = Math.min(
      (rawMax as number | undefined) ?? LIMITS.textDefaultMax,
      LIMITS.textValue,
    )
    const field: PluginFormField = {
      ...base,
      type,
      value: (optionalText(o, 'value', path, maxLength) ?? '').slice(0, maxLength),
      maxLength,
    }
    set(field, 'placeholder', optionalText(o, 'placeholder', path, LIMITS.placeholder))
    if (optionalFlag(o, 'required', path)) field.required = true
    return field
  }
  return bad(`${path}.type`, 'must be switch, choice or text')
}

function parseForm(o: Raw, check: ViewCheck): PluginFormContent {
  const keys = new Set<string>()
  const fields = array(o.fields, 'fields', LIMITS.formFields).map((item, i) =>
    parseField(item, i, keys),
  )
  if (fields.length === 0) return bad('fields', 'must have a field')
  const submit = parseAction(o.submit, 'submit', check)
  if (submit.open) return bad('submit', 'cannot open a view, since it sends the values')
  const others = common(o, check)
  if (others.actions?.some((action) => action.id === submit.id)) {
    return bad('actions', 'has the id of submit')
  }
  return { kind: 'form', ...others, fields, submit }
}

function parseActionsView(o: Raw, check: ViewCheck): PluginActionsContent {
  const others = common(o, check)
  if (!others.actions || others.actions.length === 0) return bad('actions', 'must have an action')
  const content: PluginActionsContent = { kind: 'actions', ...others, actions: others.actions }
  set(content, 'text', optionalText(o, 'text', '', LIMITS.text))
  return content
}

/** Checks what a view's script answered against the kind the manifest declared for it. */
export function parseViewContent(
  kind: PluginViewKind,
  value: unknown,
  check: ViewCheck,
): PluginViewContent {
  if (!isRecord(value)) return bad('The answer', 'must be an object')
  switch (kind) {
    case 'list':
      return parseList(value, check)
    case 'detail':
      return parseDetail(value, check)
    case 'form':
      return parseForm(value, check)
    case 'actions':
      return parseActionsView(value, check)
  }
}

/**
 * Checks what an action's script answered: nothing, or a notice to show, or a view to go to. A
 * script that returns `error` refuses the action, and says why in its own words.
 */
export function parseActionResult(value: unknown, check: ViewCheck): PluginViewActionResult {
  if (value === undefined || value === null) return { ok: true }
  const o = record(value, 'The answer')
  const error = optionalText(o, 'error', '', LIMITS.error)
  if (error !== undefined && error.trim() !== '') {
    return { ok: false, error: { code: 'failed', detail: error } }
  }
  const result: Extract<PluginViewActionResult, { ok: true }> = { ok: true }
  set(result, 'notice', optionalText(o, 'notice', '', LIMITS.notice))
  if (o.open !== undefined && o.open !== null) {
    const open = record(o.open, 'open')
    const view = open.view
    if (typeof view !== 'string' || !PLUGIN_VIEW_ID.test(view) || !check.views.has(view)) {
      return bad('open.view', 'is not a view of this plugin')
    }
    const params = parseParams(open.params, 'open.params')
    result.open = Object.keys(params).length > 0 ? { view, params } : { view }
  }
  return result
}

/** The values a window sends with an action: switches as booleans, the rest as text. */
export function parseFormValues(value: unknown, path: string): PluginFormValues {
  const o = record(value, path)
  const keys = Object.keys(o)
  if (keys.length > LIMITS.formFields)
    return bad(path, `has more than ${LIMITS.formFields} entries`)
  const out: PluginFormValues = {}
  for (const key of keys) {
    if (!PLUGIN_FIELD_KEY.test(key)) return bad(`${path}.${key.slice(0, 40)}`, 'is not a name')
    const item = o[key]
    if (typeof item === 'boolean') out[key] = item
    else if (typeof item === 'string' && item.length <= LIMITS.textValue) out[key] = item
    else return bad(`${path}.${key}`, 'must be true, false or short text')
  }
  return out
}
