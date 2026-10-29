// @ts-check
// Checks a pull request's title and description against the Git conventions in AGENTS.md. CI
// passes them in PR_TITLE and PR_BODY; run it the same way to check a pull request before opening
// it:
//
//   PR_TITLE='fix(ui): close the model menu' PR_BODY='Closes #12' node tools/workflow/pr-check.mjs
//
// It prints one line for each problem and exits with 1 when there is any. No dependencies.

import { TYPES, parseTitle } from './commit-title.mjs'

// The squash commit appends " (#N)" to the title.
const MAX_TITLE = 50
const SCOPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ISSUE_LINK =
  /\b(?:closes|fixes|resolves|refs)[ \t]+(?:#|https:\/\/github\.com\/KettuAI\/Kettu\/issues\/)\d+\b/i
// GitHub links nothing in comments or code, and the pull request template's example sits in one.
const UNLINKED = /<!--[\s\S]*?(?:-->|$)|```[\s\S]*?(?:```|$)|`[^`\n]*`/g

/**
 * @param {string} title
 * @returns {string[]} the problems, empty when the title passes
 */
export function checkTitle(title) {
  const problems = []
  const trimmed = title.trim()
  if (trimmed !== title) problems.push('Remove the spaces at its start and end.')
  const parts = parseTitle(trimmed)
  if (!parts) {
    problems.push('Write it as `type(scope): subject`, such as `fix(ui): close the model menu`.')
  } else {
    const { type, scope, subject } = parts
    const lowercase = type.toLowerCase()
    if (!TYPES.includes(lowercase)) {
      problems.push(`\`${type}\` is not a type; use one of ${TYPES.join(', ')}.`)
    } else if (type !== lowercase) {
      problems.push(`Write the type in lowercase: \`${lowercase}\`.`)
    }
    if (scope !== undefined && !SCOPE.test(scope)) {
      problems.push('Write the scope in lowercase kebab-case, such as `top-bar`, or leave it out.')
    }
    if (!subject.trim()) {
      problems.push('Add a subject after the colon.')
    } else {
      if (subject !== subject.trimStart()) problems.push('Put exactly one space after the colon.')
      if (/^\p{Lu}/u.test(subject.trimStart())) {
        problems.push('Start the subject with a lowercase letter.')
      }
      if (subject.endsWith('.')) problems.push('Drop the period at the end.')
    }
  }
  const length = [...trimmed].length
  if (length > MAX_TITLE) {
    problems.push(
      `Shorten it to ${MAX_TITLE} characters (it has ${length}); the squash commit appends \` (#N)\`.`,
    )
  }
  return problems
}

/**
 * @param {string} body
 * @returns {string[]} the problems, empty when the description passes
 */
export function checkBody(body) {
  if (ISSUE_LINK.test(body.replace(UNLINKED, ''))) return []
  return [
    'Link the issue with `Closes #N`, or `Refs #N` when the pull request does only part of it.',
  ]
}

if (import.meta.main) {
  const problems = [
    ...checkTitle(process.env.PR_TITLE ?? '').map((problem) => `Title: ${problem}`),
    ...checkBody(process.env.PR_BODY ?? '').map((problem) => `Description: ${problem}`),
  ]
  for (const problem of problems) {
    // In Actions, an error annotation also shows the problem on the run's summary page.
    const annotation = `::error::${problem.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`
    console.log(process.env.GITHUB_ACTIONS === 'true' ? annotation : problem)
  }
  if (problems.length > 0) process.exitCode = 1
  else console.log('The title and description pass.')
}
