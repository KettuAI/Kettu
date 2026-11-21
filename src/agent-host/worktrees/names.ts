// Names for worktrees: the branch from the project's template and the folder from the branch.
// Branch names reach git as arguments, so they are checked here by Git's own rules first.

import { createHash } from 'node:crypto'
import path from 'node:path'
import {
  branchProblem,
  MAX_BRANCH_LENGTH,
  fillBranchTemplate,
  unknownPlaceholder,
  type TemplateValues,
} from '@shared/branch-name'
import type { Platform } from '@shared/platform'
import { invalidParams } from '../errors'
import { t } from '../i18n'
import { pathKey } from '../paths'

const MAX_SLUG_LENGTH = 40
const MAX_FOLDER_PREFIX = 24

/** The leading ASCII words of `text` as a slug, or '' when none is usable. */
export function slugOf(text: string): string {
  return joinWords(text.split(/\s+/).map((raw) => raw.toLowerCase().replace(/[^a-z0-9]/g, '')))
}

/**
 * The slug in a model's reply, which is untrusted: its ASCII letters and digits, lowercased, with
 * single dashes between the words they make; '' when none is left.
 */
export function cleanSlug(reply: string): string {
  return joinWords(reply.replace(/[A-Z]/g, (letter) => letter.toLowerCase()).split(/[^a-z0-9]+/))
}

/** Whole words joined by dashes up to MAX_SLUG_LENGTH; only a lone first word is cut. */
function joinWords(words: readonly string[]): string {
  let slug = ''
  for (const word of words) {
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

/** Fills the template's `{slug}`, `{type}` and `{issue}`; the result is not yet checked. */
export function branchFromTemplate(template: string, values: TemplateValues): string {
  const filled = fillBranchTemplate(template, values)
  if (filled === null) {
    throw invalidParams(
      t('worktree.unknownPlaceholder', { placeholder: String(unknownPlaceholder(template)) }),
      { field: 'branch' },
    )
  }
  return filled
}

/**
 * Rejects what `git check-ref-format --branch` rejects, plus a leading `-`, which git would read
 * as an option, and names longer than 100 characters.
 */
export function checkWorktreeBranch(name: string): string {
  const reason = branchProblem(name)
  if (reason !== null) {
    throw invalidParams(
      t('worktree.unusableBranch', {
        name: JSON.stringify(name),
        reason: t(`worktree.branchProblem.${reason}`, { max: MAX_BRANCH_LENGTH }),
      }),
      { field: 'branch' },
    )
  }
  return name
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
