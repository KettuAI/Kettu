// A worktree's branch name: the project's template filled in, and Git's rules for a new branch,
// shared so New session tells what the host will refuse before the send.

import { DEFAULT_BRANCH_TEMPLATE } from './git'

export const MAX_BRANCH_LENGTH = 100

export interface TemplateValues {
  slug: string
  type?: string
  issue?: string
}

const PLACEHOLDER = /\{([^{}]*)\}/g
const KNOWN = new Set(['slug', 'type', 'issue'])

/** The first placeholder of the template other than `{slug}`, `{type}` and `{issue}`, or null. */
export function unknownPlaceholder(template: string): string | null {
  for (const match of templateOf(template).matchAll(PLACEHOLDER)) {
    if (!KNOWN.has(match[1]!)) return match[0]
  }
  return null
}

/**
 * Fills the template's `{slug}`, `{type}` and `{issue}`, or gives null when it holds another
 * placeholder; the result is not yet checked.
 */
export function fillBranchTemplate(template: string, values: TemplateValues): string | null {
  if (unknownPlaceholder(template) !== null) return null
  const issue = values.issue?.trim() ?? ''
  let filled = templateOf(template)
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

export type BranchProblem =
  | 'empty'
  | 'tooLong'
  | 'dash'
  | 'reserved'
  | 'special'
  | 'dots'
  | 'atBrace'
  | 'emptyComponent'
  | 'endsDot'
  | 'componentDot'
  | 'componentLock'

/**
 * Why `git check-ref-format --branch` would refuse the name, or a leading `-`, which git would read
 * as an option, or more than 100 characters; null when it is usable.
 */
export function branchProblem(name: string): BranchProblem | null {
  if (name === '') return 'empty'
  if (name.length > MAX_BRANCH_LENGTH) return 'tooLong'
  if (name.startsWith('-')) return 'dash'
  if (name === '@' || name === 'HEAD') return 'reserved'
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return 'special'
  if (name.includes('..')) return 'dots'
  if (name.includes('@{')) return 'atBrace'
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) return 'emptyComponent'
  if (name.endsWith('.')) return 'endsDot'
  for (const component of name.split('/')) {
    if (component.startsWith('.')) return 'componentDot'
    if (component.endsWith('.lock')) return 'componentLock'
  }
  return null
}

function templateOf(template: string): string {
  return template.trim() === '' ? DEFAULT_BRANCH_TEMPLATE : template
}
