import type { TFunction } from 'i18next'
import { getDomain } from 'tldts'
import type { FormField, FormValues } from '@shared/thread'

/** The address a link goes to, http and https only; null for anything else. */
export function webUrl(url: string): URL | null {
  const parsed = URL.parse(url)
  return parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed : null
}

/** The site a link names: its registrable domain, or its host where it has none. */
export function siteOf(url: string): string {
  const parsed = webUrl(url)
  if (!parsed) return url
  return getDomain(parsed.hostname) ?? parsed.hostname
}

/** Each field's starting value: the server's default, or empty. */
export function startValues(fields: FormField[]): Partial<FormValues> {
  const values: Partial<FormValues> = {}
  for (const field of fields) {
    if (field.default !== undefined) values[field.key] = field.default
    else if (field.type === 'boolean') values[field.key] = false
    else if (field.type === 'choices') values[field.key] = []
  }
  return values
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Why a field's value cannot go, or null; the host checks the same again. */
export function fieldError(
  field: FormField,
  value: FormValues[string] | undefined,
  t: TFunction<'session'>,
): string | null {
  const empty = value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
  if (empty) return field.required ? t('elicitation.required') : null
  switch (field.type) {
    case 'text': {
      const text = String(value)
      if (field.minLength !== undefined && text.length < field.minLength) {
        return t('elicitation.tooShort', { count: field.minLength })
      }
      if (field.maxLength !== undefined && text.length > field.maxLength) {
        return t('elicitation.tooLong', { count: field.maxLength })
      }
      if (field.format === 'email' && !EMAIL.test(text)) return t('elicitation.notEmail')
      if (field.format === 'uri' && !webUrl(text)) return t('elicitation.notUrl')
      if (field.format === 'date' && !DATE.test(text)) return t('elicitation.notDate')
      return null
    }
    case 'number': {
      const n = Number(value)
      if (!Number.isFinite(n) || (field.integer && !Number.isInteger(n))) {
        return t(field.integer ? 'elicitation.notInteger' : 'elicitation.notNumber')
      }
      if (field.minimum !== undefined && n < field.minimum) {
        return t('elicitation.atLeast', { value: field.minimum })
      }
      if (field.maximum !== undefined && n > field.maximum) {
        return t('elicitation.atMost', { value: field.maximum })
      }
      return null
    }
    case 'choices': {
      const count = (value as string[]).length
      if (field.minItems !== undefined && count < field.minItems) {
        return t('elicitation.pickAtLeast', { count: field.minItems })
      }
      if (field.maxItems !== undefined && count > field.maxItems) {
        return t('elicitation.pickAtMost', { count: field.maxItems })
      }
      return null
    }
    default:
      return null
  }
}

/** The values as the host takes them: numbers as numbers, empty optional fields left out. */
export function toValues(fields: FormField[], draft: Partial<FormValues>): FormValues {
  const values: FormValues = {}
  for (const field of fields) {
    const value = draft[field.key]
    if (value === undefined || value === '') continue
    if (Array.isArray(value) && value.length === 0 && !field.required) continue
    values[field.key] = field.type === 'number' ? Number(value) : value
  }
  return values
}
