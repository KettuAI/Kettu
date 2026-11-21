// One key of a harness's own configuration file, read and changed in place: JSON and JSONC through
// jsonc-parser, YAML through yaml's document API and TOML through toml-patch, so every other key,
// comment and line stays as the user wrote it.

import { readFile } from 'node:fs/promises'
import { applyEdits, modify, parse as parseJsonc, type ParseError } from 'jsonc-parser'
import {
  parse as parseToml,
  patch as patchToml,
  stringify as stringifyToml,
} from '@decimalturn/toml-patch'
import { Document, isMap, parseDocument } from 'yaml'
import { t } from '../i18n'
import { isObject, writeTextAtomic } from '../settings-file'

export type ConfigFormat = 'json' | 'yaml' | 'toml'

/** A key's place in the file, one segment per level, so a segment may hold dots or slashes. */
export type KeyPath = readonly string[]

async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

// Rewriting a file Kettu cannot read would lose what the user wrote in it.
function unreadable(file: string, format: ConfigFormat): Error {
  const name = format === 'json' ? 'JSON' : format === 'yaml' ? 'YAML' : 'TOML'
  return new Error(t('agentConfig.invalidFile', { file, format: name }))
}

function parseText(file: string, format: ConfigFormat, text: string): Record<string, unknown> {
  if (text.trim() === '') return {}
  let parsed: unknown
  if (format === 'json') {
    const errors: ParseError[] = []
    parsed = parseJsonc(text, errors, { allowTrailingComma: true })
    if (errors.length > 0) throw unreadable(file, format)
  } else if (format === 'yaml') {
    const doc = parseDocument(text)
    if (doc.errors.length > 0) throw unreadable(file, format)
    parsed = doc.toJS() ?? {}
  } else {
    try {
      // Integers past the safe range stay bigints, so patching never rewrites them rounded.
      parsed = parseToml(text)
    } catch {
      throw unreadable(file, format)
    }
  }
  if (!isObject(parsed)) throw new Error(t('agentConfig.notTable', { file }))
  return parsed
}

/** The file as an object; an absent or empty file is an empty one. */
export async function readConfig(
  file: string,
  format: ConfigFormat,
): Promise<Record<string, unknown>> {
  return parseText(file, format, await readText(file))
}

export function valueAt(config: unknown, key: KeyPath): unknown {
  let current = config
  for (const segment of key) {
    if (!isObject(current)) return undefined
    current = current[segment]
  }
  return current
}

/** The longest leading part of `key` whose object, once the key is gone, holds nothing. */
function emptiedParents(config: Record<string, unknown>, key: KeyPath): number {
  let depth = key.length - 1
  while (depth > 0) {
    const parent = valueAt(config, key.slice(0, depth))
    if (!isObject(parent) || Object.keys(parent).some((name) => name !== key[depth])) break
    depth -= 1
  }
  return depth + 1
}

function checkParents(file: string, config: Record<string, unknown>, key: KeyPath): void {
  for (let depth = 1; depth < key.length; depth++) {
    const parent = valueAt(config, key.slice(0, depth))
    if (parent !== undefined && !isObject(parent)) {
      throw new Error(t('agentConfig.parentNotTable', { key: key.slice(0, depth).join('.'), file }))
    }
  }
}

/**
 * Sets the key to `value`, or removes it for undefined along with the tables it leaves empty.
 * Returns whether the file changed.
 */
export async function setConfigValue(
  file: string,
  format: ConfigFormat,
  key: KeyPath,
  value: unknown,
): Promise<boolean> {
  const text = await readText(file)
  const config = parseText(file, format, text)
  checkParents(file, config, key)
  const current = valueAt(config, key)
  if (current === value) return false
  if (value === undefined && current === undefined) return false
  const removed = value === undefined ? key.slice(0, emptiedParents(config, key)) : key
  let next: string
  if (format === 'json') {
    const edits = modify(text, [...removed], value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
    })
    next = applyEdits(text, edits)
    if (!next.endsWith('\n')) next += '\n'
  } else if (format === 'yaml') {
    const doc = text.trim() === '' ? new Document({}) : parseDocument(text)
    if (!isMap(doc.contents) && doc.contents !== null) throw unreadable(file, format)
    if (value === undefined) doc.deleteIn(removed)
    else doc.setIn(removed, value)
    next = String(doc)
  } else {
    // A fresh parse, since a copy would turn TOML's dates into plain ones.
    const updated = parseText(file, format, text)
    if (value === undefined) {
      const parent = valueAt(updated, removed.slice(0, -1))
      if (isObject(parent)) delete parent[removed[removed.length - 1]]
    } else {
      let parent: Record<string, unknown> = updated
      for (const segment of key.slice(0, -1)) {
        if (!isObject(parent[segment])) parent[segment] = {}
        parent = parent[segment] as Record<string, unknown>
      }
      parent[key[key.length - 1]] = value
    }
    next = text.trim() === '' ? stringifyToml(updated) : patchToml(text, updated)
  }
  await writeTextAtomic(file, next)
  return true
}
