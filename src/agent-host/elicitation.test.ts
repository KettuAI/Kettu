import { describe, expect, it } from 'vitest'
import type { FormField } from '@shared/thread'
import { answeredFields, checkedValues, formFields, isWebUrl } from './elicitation'

describe('formFields', () => {
  it('turns each kind of property into a field, in the schema order', () => {
    expect(
      formFields({
        type: 'object',
        properties: {
          email: { type: 'string', title: 'Email', format: 'email', maxLength: 80 },
          name: { type: 'string', minLength: 1, default: 'Ada', description: 'Your name' },
          age: { type: 'integer', minimum: 0, maximum: 150, default: 30 },
          ratio: { type: 'number', maximum: 1.5 },
          subscribe: { type: 'boolean', title: 'Subscribe', default: true },
          size: { type: 'string', enum: ['s', 'm'], enumNames: ['Small', 'Medium'], default: 'm' },
          color: {
            type: 'string',
            oneOf: [
              { const: 'red', title: 'Red' },
              { const: 'blue', title: 'Blue' },
            ],
          },
          tags: {
            type: 'array',
            items: { type: 'string', enum: ['a', 'b', 'c'] },
            minItems: 1,
            maxItems: 2,
            default: ['a'],
          },
          places: {
            type: 'array',
            items: { anyOf: [{ const: 'home', title: 'Home' }] },
          },
        },
        required: ['email', 'age', 'missing'],
      }),
    ).toEqual([
      {
        key: 'email',
        title: 'Email',
        required: true,
        type: 'text',
        format: 'email',
        maxLength: 80,
      },
      {
        key: 'name',
        title: 'name',
        description: 'Your name',
        required: false,
        type: 'text',
        minLength: 1,
        default: 'Ada',
      },
      {
        key: 'age',
        title: 'age',
        required: true,
        type: 'number',
        integer: true,
        minimum: 0,
        maximum: 150,
        default: 30,
      },
      {
        key: 'ratio',
        title: 'ratio',
        required: false,
        type: 'number',
        integer: false,
        maximum: 1.5,
      },
      { key: 'subscribe', title: 'Subscribe', required: false, type: 'boolean', default: true },
      {
        key: 'size',
        title: 'size',
        required: false,
        type: 'choice',
        choices: [
          { value: 's', label: 'Small' },
          { value: 'm', label: 'Medium' },
        ],
        default: 'm',
      },
      {
        key: 'color',
        title: 'color',
        required: false,
        type: 'choice',
        choices: [
          { value: 'red', label: 'Red' },
          { value: 'blue', label: 'Blue' },
        ],
      },
      {
        key: 'tags',
        title: 'tags',
        required: false,
        type: 'choices',
        choices: [
          { value: 'a', label: 'a' },
          { value: 'b', label: 'b' },
          { value: 'c', label: 'c' },
        ],
        minItems: 1,
        maxItems: 2,
        default: ['a'],
      },
      {
        key: 'places',
        title: 'places',
        required: false,
        type: 'choices',
        choices: [{ value: 'home', label: 'Home' }],
      },
    ])
  })

  it('gives no fields for an empty schema and drops a default of the wrong kind', () => {
    expect(formFields({ type: 'object', properties: {} })).toEqual([])
    expect(formFields({ type: 'object' })).toEqual([])
    expect(
      formFields({ type: 'object', properties: { n: { type: 'number', default: 'x' } } }),
    ).toEqual([{ key: 'n', title: 'n', required: false, type: 'number', integer: false }])
  })

  it('refuses what a card cannot show', () => {
    const one = (prop: unknown) => formFields({ type: 'object', properties: { x: prop } })
    expect(formFields(null)).toBeNull()
    expect(formFields({ type: 'array', items: {} })).toBeNull()
    expect(one({ type: 'object', properties: {} })).toBeNull()
    expect(one({ type: 'string', format: 'hostname' })).toBeNull()
    expect(one({ type: 'string', maxLength: -1 })).toBeNull()
    expect(one({ type: 'string', enum: [] })).toBeNull()
    expect(one({ type: 'string', enum: ['a', 1] })).toBeNull()
    expect(one({ type: 'string', enum: ['a', 'a'] })).toBeNull()
    expect(one({ type: 'array', items: { type: 'number', enum: ['1'] } })).toBeNull()
    expect(one({ type: 'array', items: { type: 'string' } })).toBeNull()
    expect(one({ type: 'number', minimum: 'low' })).toBeNull()
    expect(one({ type: 'null' })).toBeNull()
    const many = Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [`f${i}`, { type: 'string' }]),
    )
    expect(formFields({ type: 'object', properties: many })).toBeNull()
  })
})

const fields: FormField[] = [
  { key: 'name', title: 'Name', required: true, type: 'text', minLength: 2, maxLength: 5 },
  { key: 'note', title: 'Note', required: false, type: 'text' },
  { key: 'mail', title: 'Mail', required: false, type: 'text', format: 'email' },
  { key: 'site', title: 'Site', required: false, type: 'text', format: 'uri' },
  { key: 'day', title: 'Day', required: false, type: 'text', format: 'date' },
  { key: 'at', title: 'At', required: false, type: 'text', format: 'date-time' },
  {
    key: 'age',
    title: 'Age',
    required: false,
    type: 'number',
    integer: true,
    minimum: 0,
    maximum: 9,
  },
  { key: 'ok', title: 'OK', required: false, type: 'boolean' },
  {
    key: 'size',
    title: 'Size',
    required: false,
    type: 'choice',
    choices: [
      { value: 's', label: 'Small' },
      { value: 'm', label: 'Medium' },
    ],
  },
  {
    key: 'tags',
    title: 'Tags',
    required: false,
    type: 'choices',
    choices: [
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta' },
      { value: 'c', label: 'Gamma' },
    ],
    minItems: 1,
    maxItems: 2,
  },
]

describe('checkedValues', () => {
  it('takes values that fit, and leaves an optional text left empty out', () => {
    const values = {
      name: 'Ada',
      note: '',
      mail: 'ada@example.com',
      site: 'https://example.com/a',
      day: '2026-02-28',
      at: '2026-11-05T09:30:00+08:00',
      age: 3,
      ok: false,
      size: 'm',
      tags: ['b', 'a'],
    }
    const { note, ...sent } = values
    expect(note).toBe('')
    expect(checkedValues(fields, values)).toEqual(sent)
    expect(checkedValues(fields, { name: '😀😀' })).toEqual({ name: '😀😀' })
  })

  it('refuses a missing required field, an unknown key and a value of the wrong kind', () => {
    const refused = (values: Record<string, unknown>) =>
      expect(() => checkedValues(fields, { name: 'Ada', ...values } as never)).toThrow()
    expect(() => checkedValues(fields, {})).toThrow(/Name is required/)
    expect(() => checkedValues(fields, { name: '' })).toThrow(/Name is required/)
    refused({ other: 'x' })
    refused({ name: 'A' })
    // A character outside the BMP counts once, as JSON Schema counts it.
    refused({ name: '😀' })
    refused({ name: 'Adaline' })
    refused({ name: 5 })
    refused({ mail: 'ada' })
    refused({ site: 'javascript:alert(1)' })
    refused({ site: 'ftp://example.com' })
    refused({ day: '2026-02-30' })
    refused({ day: '05/11/2026' })
    refused({ at: '2026-11-05T09:30' })
    refused({ at: '2026-11-05T25:30:00Z' })
    refused({ age: 2.5 })
    refused({ age: 10 })
    refused({ age: '3' })
    refused({ ok: 'yes' })
    refused({ size: 'l' })
    refused({ tags: [] })
    refused({ tags: ['a', 'b', 'c'] })
    refused({ tags: ['a', 'a'] })
    refused({ tags: ['z'] })
    refused({ tags: 'a' })
  })
})

describe('answeredFields', () => {
  it('keeps each field sent by its title, with choices by their labels', () => {
    expect(
      answeredFields(fields, { name: 'Ada', age: 3, ok: true, size: 's', tags: ['a', 'c'] }),
    ).toEqual([
      { title: 'Name', value: 'Ada' },
      { title: 'Age', value: '3' },
      { title: 'OK', value: 'Yes' },
      { title: 'Size', value: 'Small' },
      { title: 'Tags', value: 'Alpha, Gamma' },
    ])
  })
})

describe('isWebUrl', () => {
  it('takes only http and https', () => {
    expect(isWebUrl('https://example.com/auth?x=1')).toBe(true)
    expect(isWebUrl('http://localhost:3000')).toBe(true)
    expect(isWebUrl('file:///etc/passwd')).toBe(false)
    expect(isWebUrl('vscode://open')).toBe(false)
    expect(isWebUrl('not a url')).toBe(false)
  })
})
