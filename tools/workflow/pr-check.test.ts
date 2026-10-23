import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkBody, checkTitle } from './pr-check.mjs'

describe('checkTitle', () => {
  it('passes Conventional Commits titles', () => {
    for (const title of [
      'fix(ui): close the model menu',
      'feat: add usage statistics',
      'feat(top-bar)!: replace the git popover',
      'chore(release): v0.1.0',
      'refactor(i18n): load catalogs lazily',
      'build: bump electron to 44',
      'docs: explain `pnpm test`',
      'ci: check pull request titles and links',
    ]) {
      expect(checkTitle(title), title).toEqual([])
    }
  })

  it('names a missing header', () => {
    expect(checkTitle('Close the model menu')).toEqual([
      'Write it as `type(scope): subject`, such as `fix(ui): close the model menu`.',
    ])
    expect(checkTitle('fix:close the menu')).toHaveLength(1)
    expect(checkTitle('')).toHaveLength(1)
  })

  it('names an unknown or capitalized type', () => {
    expect(checkTitle('feature: add login')).toEqual([
      '`feature` is not a type; use one of feat, fix, docs, style, refactor, test, chore, perf, ci, revert, build.',
    ])
    expect(checkTitle('Fix: close the menu')).toEqual(['Write the type in lowercase: `fix`.'])
  })

  it('wants a lowercase kebab-case scope', () => {
    const problem = 'Write the scope in lowercase kebab-case, such as `top-bar`, or leave it out.'
    expect(checkTitle('fix(UI): close the menu')).toEqual([problem])
    expect(checkTitle('fix(top_bar): close the menu')).toEqual([problem])
    expect(checkTitle('fix(top bar): close the menu')).toEqual([problem])
    expect(checkTitle('fix(): close the menu')).toEqual([problem])
  })

  it('wants a lowercase subject without a period', () => {
    expect(checkTitle('fix: Close the menu')).toEqual([
      'Start the subject with a lowercase letter.',
    ])
    expect(checkTitle('fix: close the menu.')).toEqual(['Drop the period at the end.'])
    expect(checkTitle('fix:')).toEqual(['Add a subject after the colon.'])
    expect(checkTitle('fix:  close the menu')).toEqual(['Put exactly one space after the colon.'])
  })

  it('counts at most 50 characters', () => {
    const fifty = `fix: ${'a'.repeat(45)}`
    expect(checkTitle(fifty)).toEqual([])
    expect(checkTitle(`${fifty}b`)).toEqual([
      'Shorten it to 50 characters (it has 51); the squash commit appends ` (#N)`.',
    ])
  })

  it('names spaces around the title and still checks the rest', () => {
    expect(checkTitle(' fix: close the menu.')).toEqual([
      'Remove the spaces at its start and end.',
      'Drop the period at the end.',
    ])
  })

  it('lists every problem', () => {
    expect(checkTitle(`Feat(UI): Add ${'a'.repeat(50)}.`)).toHaveLength(5)
  })
})

describe('checkBody', () => {
  it('passes each keyword, in any case, with a number or the issue URL', () => {
    for (const body of [
      'Closes #6',
      'Fixes #6',
      'resolves #6',
      'REFS #6',
      'Adds the check.\n\nCloses https://github.com/overbench/overbench/issues/6\n\nRan the tests.',
      'Closes #6, and refs #7.',
    ]) {
      expect(checkBody(body), body).toEqual([])
    }
  })

  it('fails without an issue link', () => {
    const problem =
      'Link the issue with `Closes #N`, or `Refs #N` when the pull request does only part of it.'
    for (const body of [
      '',
      'Adds the check for #6.',
      'Closes #',
      'Closes 6',
      'Closes #6a',
      'Encloses #6',
      'Closes https://github.com/someone/else/issues/6',
      'Closes https://github.com/overbench/overbench/pull/6',
    ]) {
      expect(checkBody(body), body).toEqual([problem])
    }
  })

  it('ignores links in comments and code, as GitHub does', () => {
    const template = [
      '<!-- What changes and why, in one or two sentences. -->',
      '',
      '<!-- Link the issue: Closes #123, or Refs #123 when it stays open. -->',
      '',
      'Closes #',
    ].join('\n')
    expect(checkBody(template)).toHaveLength(1)
    expect(checkBody(`${template}6`)).toEqual([])
    expect(checkBody('Write `Closes #6` to close it.')).toHaveLength(1)
    expect(checkBody('```\nCloses #6\n```')).toHaveLength(1)
    expect(checkBody('<!-- Closes #6')).toHaveLength(1)
  })
})

describe('pr-check.mjs', () => {
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, [join(import.meta.dirname, 'pr-check.mjs')], {
      env: { ...process.env, GITHUB_ACTIONS: '', ...env },
      encoding: 'utf8',
    })

  it('reads PR_TITLE and PR_BODY and exits 0 when they pass', () => {
    const result = run({ PR_TITLE: 'ci: check pull requests', PR_BODY: 'Closes #6' })
    expect(result.stdout).toBe('The title and description pass.\n')
    expect(result.status).toBe(0)
  })

  it('prints each problem and exits 1, as annotations in Actions', () => {
    expect(run({ PR_TITLE: 'ci: check pull requests.', PR_BODY: '' })).toMatchObject({
      status: 1,
      stdout:
        'Title: Drop the period at the end.\n' +
        'Description: Link the issue with `Closes #N`, or `Refs #N` when the pull request does only part of it.\n',
    })
    expect(run({ GITHUB_ACTIONS: 'true', PR_TITLE: '50%: off', PR_BODY: 'Closes #6' }).stdout).toBe(
      '::error::Title: `50%25` is not a type; use one of feat, fix, docs, style, refactor, test, chore, perf, ci, revert, build.\n',
    )
  })
})
