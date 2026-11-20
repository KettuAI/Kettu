// Opens one issue for each harness version whose check failed twice in a row, unless an issue of
// the same title exists, open or closed. A run that could not open one tries again the next day.
//
//   node tools/harness-checks/report.mjs <harness-checks.json> [--dry-run]
//
// Needs GH_TOKEN and GH_REPO; with --dry-run it only says what it would open.

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { parseArgs } from 'node:util'

const run = promisify(execFile)

const NAMES = {
  'claude-code': 'Claude Agent SDK',
  codex: 'Codex',
  deepseek: 'DeepSeek Harness',
  'qoder-cn': 'Qoder CN',
  muse: 'Muse Code',
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'dry-run': { type: 'boolean', default: false } },
})
const [file] = positionals
if (!file) throw new Error('Usage: report.mjs <harness-checks.json> [--dry-run]')
const data = JSON.parse(await readFile(file, 'utf8'))
const repo = process.env.GH_REPO
if (!values['dry-run'] && !repo) throw new Error('GH_REPO names no repository')

const runUrl =
  process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY
    ? `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null

let failed = 0
for (const result of data.results.filter(
  (entry) => entry.status === 'fail' && entry.failures >= 2,
)) {
  const title = `Harness check fails: ${NAMES[result.harness] ?? result.harness} ${result.version}`
  try {
    if (await exists(title)) {
      console.log(`Already filed: ${title}`)
      continue
    }
    const body = bodyOf(result)
    if (values['dry-run']) {
      console.log(`Would open: ${title}\n${body}`)
      continue
    }
    console.log(`Opened ${await open(title, body)}`)
  } catch (error) {
    failed++
    console.error(`Could not file ${title}: ${error.message}`)
  }
}
if (failed > 0) process.exitCode = 1

async function exists(title) {
  if (!repo) return false
  const { stdout } = await gh([
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'all',
    '--search',
    `"${title}" in:title`,
    '--limit',
    '20',
    '--json',
    'title',
  ])
  return JSON.parse(stdout).some((issue) => issue.title === title)
}

function bodyOf(result) {
  const lines = [
    `The daily harness check failed for ${NAMES[result.harness] ?? result.harness} ${result.version} ` +
      `${result.failures} times in a row, at the \`${result.step}\` step. ` +
      `It was published ${result.publishedAt} and last checked ${result.checkedAt}` +
      (runUrl ? ` in ${runUrl}.` : '.'),
    '',
    'The end of its log:',
    '',
    '```text',
    result.log.replaceAll('```', "'''").trimEnd(),
    '```',
  ]
  return `${lines.join('\n')}\n`
}

async function open(title, body) {
  const fields = ['-f', `title=${title}`, '-f', `body=${body}`]
  const path = `repos/${repo}/issues`
  try {
    const { stdout } = await gh(['api', path, ...fields, '-f', 'type=Bug', '--jq', '.html_url'])
    return stdout.trim()
  } catch (error) {
    // A token that may not set issue types still files the issue, without one.
    if (!/type/i.test(error.stderr ?? '')) throw error
    console.error(`The issue type was refused (${error.stderr.trim()}); filing without it`)
    const { stdout } = await gh(['api', path, ...fields, '--jq', '.html_url'])
    return stdout.trim()
  }
}

function gh(args) {
  return run('gh', args, { maxBuffer: 16 * 1024 * 1024 })
}
