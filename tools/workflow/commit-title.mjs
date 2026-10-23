// @ts-check
// Reads Conventional Commits 1.0.0 headers: pull request titles, and the squash commit subjects
// they become on main. No dependencies.

export const TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'test',
  'chore',
  'perf',
  'ci',
  'revert',
  'build',
]

const HEADER = /^(?<type>[^\s()!:]+)(?:\((?<scope>[^()]*)\))?(?<breaking>!)?:(?: (?<subject>.*))?$/

/**
 * Splits `type(scope)!: subject` into its parts, or returns null when the text has no such
 * header. Any type, scope and subject are accepted; pr-check.mjs judges them.
 *
 * @param {string} header
 * @returns {{ type: string, scope: string | undefined, breaking: boolean, subject: string } | null}
 */
export function parseTitle(header) {
  const groups = HEADER.exec(header)?.groups
  if (!groups) return null
  return {
    type: groups.type,
    scope: groups.scope,
    breaking: groups.breaking === '!',
    subject: groups.subject ?? '',
  }
}
