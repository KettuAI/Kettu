// Names for worktrees: the branch from the project's template and the folder from the branch.
// Branch names reach git as arguments, so they are checked here by Git's own rules first.

import { createHash } from 'node:crypto'
import path from 'node:path'
import { DEFAULT_BRANCH_TEMPLATE } from '@shared/git'
import type { Platform } from '@shared/platform'
import { invalidParams } from '../errors'
import { pathKey } from '../paths'

export const MAX_BRANCH_LENGTH = 100
export const MAX_SLUG_LENGTH = 40
const MAX_FOLDER_PREFIX = 24

/** The leading ASCII words of `text` as a slug, or '' when none is usable. */
export function slugOf(text: string): string {
  let slug = ''
  for (const raw of text.split(/\s+/)) {
    const word = raw.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (word === '') continue
    if (slug === '') {
      slug = word.slice(0, MAX_SLUG_LENGTH)
      continue
    }
    if (slug.length + 1 + word.length > MAX_SLUG_LENGTH) break
    slug += `-${word}`
  }
  return slug
}

export interface TemplateValues {
  slug: string
  type?: string
  issue?: string
}

const PLACEHOLDER = /\{([^{}]*)\}/g
const KNOWN = new Set(['slug', 'type', 'issue'])

/** Fills the template's `{slug}`, `{type}` and `{issue}`; the result is not yet checked. */
export function branchFromTemplate(template: string, values: TemplateValues): string {
  const source = template.trim() === '' ? DEFAULT_BRANCH_TEMPLATE : template
  for (const match of source.matchAll(PLACEHOLDER)) {
    if (!KNOWN.has(match[1]!))
      throw invalidParams(`Unknown placeholder in branch template: ${match[0]}`)
  }
  const issue = values.issue?.trim() ?? ''
  let filled = source
  if (issue === '') {
    // Drop one dash beside the missing issue, preferring the one after it.
    filled = filled.replace(/\{issue\}-|-\{issue\}|\{issue\}/g, '')
  }
  return filled.replace(PLACEHOLDER, (_, name: string) => {
    if (name === 'slug') return values.slug
    if (name === 'type') return values.type?.trim() || 'feat'
    return issue
  })
}

/**
 * Rejects what `git check-ref-format --branch` rejects, plus a leading `-`, which git would read
 * as an option, and names longer than 100 characters.
 */
export function checkWorktreeBranch(name: string): string {
  const reason = branchProblem(name)
  if (reason !== null)
    throw invalidParams(`Unusable branch name ${JSON.stringify(name)}: ${reason}`)
  return name
}

function branchProblem(name: string): string | null {
  if (name === '') return 'it is empty'
  if (name.length > MAX_BRANCH_LENGTH) return `it is longer than ${MAX_BRANCH_LENGTH} characters`
  if (name.startsWith('-')) return 'it starts with "-"'
  if (name === '@' || name === 'HEAD') return 'it is reserved'
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name))
    return 'it has a space, a control or a special character'
  if (name.includes('..')) return 'it has ".."'
  if (name.includes('@{')) return 'it has "@{"'
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) {
    return 'it has an empty path component'
  }
  if (name.endsWith('.')) return 'it ends with "."'
  for (const component of name.split('/')) {
    if (component.startsWith('.')) return 'a path component starts with "."'
    if (component.endsWith('.lock')) return 'a path component ends with ".lock"'
  }
  return null
}

/**
 * The worktree's folder name: the branch made safe for a single path component, short, and kept
 * apart from other branches that read the same by a hash of the branch.
 */
export function folderNameFor(branch: string, platform: Platform): string {
  const hash = createHash('sha256').update(branch).digest('hex').slice(0, 8)
  // A dot on Windows would let `con.x` name a device.
  const unsafe = platform === 'win32' ? /[^A-Za-z0-9_-]+/g : /[^A-Za-z0-9._-]+/g
  const trim = (value: string): string => value.replace(/^[.-]+|[.-]+$/g, '')
  const prefix = trim(
    trim(branch.replace(unsafe, '-').replace(/-+/g, '-')).slice(0, MAX_FOLDER_PREFIX),
  )
  return prefix === '' ? hash : `${prefix}-${hash}`
}

/** Whether `target` lies strictly inside `root`; both canonical. */
export function insideRoot(root: string, target: string, platform: Platform): boolean {
  const sep = platform === 'win32' ? path.win32.sep : path.posix.sep
  const base = pathKey(root, platform)
  const key = pathKey(target, platform)
  const prefix = base.endsWith(sep) ? base : base + sep
  return key.length > prefix.length && key.startsWith(prefix)
}
