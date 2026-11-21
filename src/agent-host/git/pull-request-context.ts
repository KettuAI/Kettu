// What a model is shown to write a pull request: the messages of the branch's commits and the
// files it changes against its base.

import type { ChangedFile } from '@shared/git'
import { expectOk, GIT_TIMEOUT_MS, type Exec } from './exec'
import { parseNameStatus, parseNumstat, withLineCounts } from './parse'

/** The newest commits read at most; a longer branch is told apart by its files. */
const COMMITS = 30

export interface PullRequestContext {
  branch: string
  base: string
  /** The branch's commits, oldest first. */
  commits: { subject: string; body: string }[]
  files: ChangedFile[]
}

/**
 * Reads what `baseRef`..HEAD holds, which the caller has checked is a branch or remote name and
 * so never an option.
 */
export async function readPullRequestContext(
  exec: Exec,
  cwd: string,
  request: { branch: string; base: string; baseRef: string },
): Promise<PullRequestContext> {
  const run = (args: string[]) => exec('git', args, { cwd, timeoutMs: GIT_TIMEOUT_MS })
  const [log, names, numbers] = await Promise.all([
    run([
      'log',
      '-n',
      String(COMMITS),
      '--reverse',
      '--no-show-signature',
      '--encoding=UTF-8',
      '--format=%s%x1f%b%x1e',
      `${request.baseRef}..HEAD`,
      '--',
    ]),
    run(['diff', '--no-ext-diff', '-z', '-M', '--name-status', `${request.baseRef}...HEAD`, '--']),
    run(['diff', '--no-ext-diff', '-z', '-M', '--numstat', `${request.baseRef}...HEAD`, '--']),
  ])
  const commits = expectOk('git log', log)
    .stdout.split('\x1e')
    .map((record) => {
      const [subject = '', body = ''] = record.split('\x1f')
      return { subject: subject.trim(), body: body.trim() }
    })
    .filter((commit) => commit.subject !== '')
  const files = withLineCounts(
    parseNameStatus(expectOk('git diff', names).stdout),
    parseNumstat(expectOk('git diff', numbers).stdout),
  )
  return { branch: request.branch, base: request.base, commits, files }
}
