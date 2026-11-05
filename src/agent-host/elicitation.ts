// An MCP server's request through an agent: the JSON Schema of its form as the fields a card shows,
// and the values a user submits, checked against those fields before they reach the agent.

import type { AnsweredField, FormChoice, FormField, FormValues } from '@shared/thread'
import { invalidParams } from './errors'
import { t } from './i18n'

/** The most fields a form may have, and the longest key one may have, so its answer can be sent. */
export const FORM_FIELDS = 100
export const FORM_KEY_CHARS = 200

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const FORMATS: ReadonlySet<unknown> = new Set(['email', 'uri', 'date', 'date-time'])

/** Thrown inside the conversion for a schema part a card cannot show. */
class Unrepresentable extends Error {}

function count(prop: Json, key: string): number | undefined {
  const value = prop[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Unrepresentable()
  }
  return value
}

function limit(prop: Json, key: string): number | undefined {
  const value = prop[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Unrepresentable()
  return value
}

/** Choices from `enum` with optional `enumNames`, or from `{ const, title }` items. */
function choices(values: unknown, names?: unknown): FormChoice[] {
  if (!Array.isArray(values) || values.length === 0) throw new Unrepresentable()
  const labels = Array.isArray(names) && names.length === values.length ? names : null
  const list = values.map((value: unknown, index): FormChoice => {
    if (typeof value === 'string') {
      const label = labels?.[index]
      return { value, label: typeof label === 'string' && label !== '' ? label : value }
    }
    if (isObject(value) && typeof value.const === 'string') {
      const title = value.title
      return {
        value: value.const,
        label: typeof title === 'string' && title !== '' ? title : value.const,
      }
    }
    throw new Unrepresentable()
  })
  if (new Set(list.map((choice) => choice.value)).size !== list.length) throw new Unrepresentable()
  return list
}

function field(key: string, prop: unknown, required: boolean): FormField {
  if (key === '' || key.length > FORM_KEY_CHARS || !isObject(prop)) throw new Unrepresentable()
  const title = typeof prop.title === 'string' && prop.title.trim() !== '' ? prop.title : key
  const base = {
    key,
    title,
    required,
    ...(typeof prop.description === 'string' && prop.description !== ''
      ? { description: prop.description }
      : {}),
  }
  const fallback = prop.default
  switch (prop.type) {
    case 'string': {
      if (prop.enum !== undefined || prop.oneOf !== undefined) {
        const list =
          prop.enum !== undefined ? choices(prop.enum, prop.enumNames) : choices(prop.oneOf)
        const known = list.some((choice) => choice.value === fallback)
        return {
          ...base,
          type: 'choice',
          choices: list,
          ...(known ? { default: fallback as string } : {}),
        }
      }
      if (prop.format !== undefined && !FORMATS.has(prop.format)) throw new Unrepresentable()
      const minLength = count(prop, 'minLength')
      const maxLength = count(prop, 'maxLength')
      return {
        ...base,
        type: 'text',
        ...(prop.format !== undefined
          ? { format: prop.format as 'email' | 'uri' | 'date' | 'date-time' }
          : {}),
        ...(minLength !== undefined ? { minLength } : {}),
        ...(maxLength !== undefined ? { maxLength } : {}),
        ...(typeof fallback === 'string' ? { default: fallback } : {}),
      }
    }
    case 'number':
    case 'integer': {
      const minimum = limit(prop, 'minimum')
      const maximum = limit(prop, 'maximum')
      return {
        ...base,
        type: 'number',
        integer: prop.type === 'integer',
        ...(minimum !== undefined ? { minimum } : {}),
        ...(maximum !== undefined ? { maximum } : {}),
        ...(typeof fallback === 'number' && Number.isFinite(fallback) ? { default: fallback } : {}),
      }
    }
    case 'boolean':
      return {
        ...base,
        type: 'boolean',
        ...(typeof fallback === 'boolean' ? { default: fallback } : {}),
      }
    case 'array': {
      const items = prop.items
      if (!isObject(items)) throw new Unrepresentable()
      let list: FormChoice[]
      if (items.enum !== undefined) {
        if (items.type !== undefined && items.type !== 'string') throw new Unrepresentable()
        list = choices(items.enum)
      } else {
        list = choices(items.anyOf)
      }
      const minItems = count(prop, 'minItems')
      const maxItems = count(prop, 'maxItems')
      const values = new Set(list.map((choice) => choice.value))
      const known =
        Array.isArray(fallback) &&
        fallback.every((value: unknown) => typeof value === 'string' && values.has(value))
      return {
        ...base,
        type: 'choices',
        choices: list,
        ...(minItems !== undefined ? { minItems } : {}),
        ...(maxItems !== undefined ? { maxItems } : {}),
        ...(known ? { default: [...(fallback as string[])] } : {}),
      }
    }
    default:
      throw new Unrepresentable()
  }
}

/**
 * An MCP `requestedSchema` as form fields, in the schema's order; an empty schema gives none.
 * Null for a schema with a part a card cannot show, such as a nested object or an unknown format.
 */
export function formFields(schema: unknown): FormField[] | null {
  if (!isObject(schema)) return null
  if (schema.type !== undefined && schema.type !== 'object') return null
  const properties = schema.properties ?? {}
  if (!isObject(properties)) return null
  const keys = Object.keys(properties)
  if (keys.length > FORM_FIELDS) return null
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((key) => typeof key === 'string') : [],
  )
  try {
    return keys.map((key) => field(key, properties[key], required.has(key)))
  } catch (error) {
    if (error instanceof Unrepresentable) return null
    throw error
  }
}

/** Only an http or https address, the pages a card offers to open. */
export function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+$/
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
// RFC 3339, which JSON Schema's date-time is: the offset is part of it.
const DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/i

function isDate(value: string): boolean {
  const match = DATE.exec(value)
  if (!match) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

function formatProblem(format: string, value: string): boolean {
  switch (format) {
    case 'email':
      return !EMAIL.test(value)
    case 'uri':
      return !isWebUrl(value)
    case 'date':
      return !isDate(value)
    case 'date-time': {
      const match = DATE_TIME.exec(value)
      return !match || !isDate(match[1]!)
    }
    default:
      return true
  }
}

function checkValue(field: FormField, value: FormValues[string]): void {
  const name = field.title
  switch (field.type) {
    case 'text': {
      if (typeof value !== 'string') throw invalidParams(`${name} takes text`)
      // JSON Schema counts characters, not UTF-16 units.
      const length = [...value].length
      if (field.minLength !== undefined && length < field.minLength) {
        throw invalidParams(`${name} takes at least ${field.minLength} characters`)
      }
      if (field.maxLength !== undefined && length > field.maxLength) {
        throw invalidParams(`${name} takes at most ${field.maxLength} characters`)
      }
      if (field.format !== undefined && formatProblem(field.format, value)) {
        throw invalidParams(`${name} is not a valid ${field.format}`)
      }
      return
    }
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw invalidParams(`${name} takes a number`)
      }
      if (field.integer && !Number.isInteger(value))
        throw invalidParams(`${name} takes a whole number`)
      if (field.minimum !== undefined && value < field.minimum) {
        throw invalidParams(`${name} takes at least ${field.minimum}`)
      }
      if (field.maximum !== undefined && value > field.maximum) {
        throw invalidParams(`${name} takes at most ${field.maximum}`)
      }
      return
    case 'boolean':
      if (typeof value !== 'boolean') throw invalidParams(`${name} takes yes or no`)
      return
    case 'choice':
      if (typeof value !== 'string' || !field.choices.some((choice) => choice.value === value)) {
        throw invalidParams(`${name} has no such choice`)
      }
      return
    case 'choices': {
      if (!Array.isArray(value)) throw invalidParams(`${name} takes a list of choices`)
      if (new Set(value).size !== value.length) throw invalidParams(`${name} names a choice twice`)
      for (const item of value) {
        if (!field.choices.some((choice) => choice.value === item)) {
          throw invalidParams(`${name} has no such choice`)
        }
      }
      if (field.minItems !== undefined && value.length < field.minItems) {
        throw invalidParams(`${name} takes at least ${field.minItems} choices`)
      }
      if (field.maxItems !== undefined && value.length > field.maxItems) {
        throw invalidParams(`${name} takes at most ${field.maxItems} choices`)
      }
      return
    }
  }
}

function given(values: FormValues, key: string): FormValues[string] | undefined {
  return Object.hasOwn(values, key) ? values[key] : undefined
}

/**
 * The values to send for a form, checked against its fields; an optional text left empty is not
 * sent. Throws `invalid_params` for a key the form lacks, a required field left out, or a value
 * its field does not take.
 */
export function checkedValues(fields: readonly FormField[], values: FormValues): FormValues {
  const keys = new Set(fields.map((item) => item.key))
  for (const key of Object.keys(values)) {
    if (!keys.has(key)) throw invalidParams(`The form has no field ${key}`)
  }
  const sent: [string, FormValues[string]][] = []
  for (const item of fields) {
    const value = given(values, item.key)
    if (value === undefined || (item.type === 'text' && value === '')) {
      if (item.required) throw invalidParams(`${item.title} is required`)
      continue
    }
    checkValue(item, value)
    sent.push([item.key, value])
  }
  return Object.fromEntries(sent)
}

function label(item: FormField, value: string): string {
  if (item.type !== 'choice' && item.type !== 'choices') return value
  return item.choices.find((choice) => choice.value === value)?.label ?? value
}

/** What the entry keeps of a submitted form: each field sent, by its title, its value as text. */
export function answeredFields(fields: readonly FormField[], values: FormValues): AnsweredField[] {
  return fields.flatMap((item) => {
    const value = given(values, item.key)
    if (value === undefined) return []
    let text: string
    if (typeof value === 'boolean') text = t(value ? 'elicitation.yes' : 'elicitation.no')
    else if (Array.isArray(value)) text = value.map((part) => label(item, part)).join(', ')
    else if (typeof value === 'string') text = label(item, value)
    else text = String(value)
    return [{ title: item.title, value: text }]
  })
}
