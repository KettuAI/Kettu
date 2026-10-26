import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChangedFile, ChangeStatus } from '@shared/git'
import { ChangeBadge } from './change-badge'
import { changesByPath } from './changes'

function changed(path: string, status: ChangeStatus): ChangedFile {
  return { path, oldPath: null, status, insertions: null, deletions: null }
}

describe('changesByPath', () => {
  it('names each change by its path in a project at the root of its repository', () => {
    const changes = changesByPath('/repo', '/repo', [
      changed('src/day-key.ts', 'modified'),
      changed('src/day-key.test.ts', 'untracked'),
    ])
    expect([...changes]).toEqual([
      ['src/day-key.ts', 'modified'],
      ['src/day-key.test.ts', 'untracked'],
    ])
  })

  it('takes paths inside a project in a subfolder and leaves the rest out', () => {
    const changes = changesByPath('/repo', '/repo/app', [
      changed('app/src/a.ts', 'added'),
      changed('lib/b.ts', 'modified'),
    ])
    expect([...changes]).toEqual([['src/a.ts', 'added']])
  })

  it('leaves out deleted files, which the pane does not list', () => {
    expect(changesByPath('/repo', '/repo', [changed('gone.ts', 'deleted')]).size).toBe(0)
  })
})

describe('ChangeBadge', () => {
  it("shows git's letter in its state's color and names the change", () => {
    const modified = renderToStaticMarkup(createElement(ChangeBadge, { status: 'modified' }))
    expect(modified).toContain('>M<')
    expect(modified).toContain('text-warning')
    expect(modified).toContain('Modified')

    const added = renderToStaticMarkup(createElement(ChangeBadge, { status: 'untracked' }))
    expect(added).toContain('>U<')
    expect(added).toContain('text-success')
  })
})
