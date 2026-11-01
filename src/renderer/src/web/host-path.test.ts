import { describe, expect, it } from 'vitest'
import type { PathCompletion } from '@shared/remote/host-admin'
import {
  canChoose,
  chosenPath,
  folderOf,
  homeStart,
  isCompletable,
  joinPath,
  lastPart,
  MAX_ENTRIES,
  pathEntries,
  restarted,
  tabComplete,
} from './host-path'

const entry = (name: string, kind: 'folder' | 'file' = 'folder', executable = false) => ({
  name,
  kind,
  executable,
})

const home: PathCompletion = {
  folder: '/Users/ana',
  entries: [
    entry('projects'),
    entry('.claude'),
    entry('notes.md', 'file'),
    entry('Pictures'),
    entry('run.sh', 'file', true),
  ],
  exact: null,
}

describe('host paths', () => {
  it('completes only an absolute path or one from the home folder', () => {
    expect(isCompletable('~/', 'darwin')).toBe(true)
    expect(isCompletable('/usr/bin', 'linux')).toBe(true)
    expect(isCompletable('projects', 'darwin')).toBe(false)
    expect(isCompletable('', 'darwin')).toBe(false)
    expect(isCompletable('C:\\Users', 'win32')).toBe(true)
    expect(isCompletable('c:/Users', 'win32')).toBe(true)
    expect(isCompletable('\\\\server\\share', 'win32')).toBe(true)
    expect(isCompletable('/Users', 'win32')).toBe(false)
  })

  it('starts at home, or beside a path already chosen', () => {
    expect(homeStart('darwin')).toBe('~/')
    expect(homeStart('win32')).toBe('~\\')
    expect(folderOf('/opt/homebrew/bin/claude', 'darwin')).toBe('/opt/homebrew/bin/')
    expect(folderOf('/zsh', 'linux')).toBe('/')
    expect(folderOf('C:\\Program Files\\Git\\bin\\bash.exe', 'win32')).toBe(
      'C:\\Program Files\\Git\\bin\\',
    )
    expect(folderOf('bash', 'linux')).toBe('~/')
  })

  it('starts over at a root typed after the path, as a file dialog does', () => {
    // The field starts at home; typing an absolute path there means that path.
    expect(restarted('~//tmp/k716', 'darwin')).toBe('/tmp/k716')
    expect(restarted('/Users/lin//etc', 'linux')).toBe('/etc')
    expect(restarted('~/~/code', 'darwin')).toBe('~/code')
    expect(restarted('~\\C:\\code', 'win32')).toBe('C:\\code')
    expect(restarted('/tmp/k716', 'darwin')).toBe('/tmp/k716')
    expect(restarted('C:\\Users\\lin', 'win32')).toBe('C:\\Users\\lin')
  })

  it('splits off the last part at either separator on Windows, at the slash elsewhere', () => {
    expect(lastPart('/Users/ana/pro', 'darwin')).toBe('pro')
    expect(lastPart('/Users/ana/', 'darwin')).toBe('')
    expect(lastPart('C:\\Users\\ana/pro', 'win32')).toBe('pro')
    expect(lastPart('a\\b', 'linux')).toBe('a\\b')
  })

  it('joins without doubling the separator of a root', () => {
    expect(joinPath('/', 'etc', 'linux')).toBe('/etc')
    expect(joinPath('/Users/ana', 'projects', 'darwin')).toBe('/Users/ana/projects')
    expect(joinPath('C:\\', 'Users', 'win32')).toBe('C:\\Users')
    expect(joinPath('C:\\Users', 'ana', 'win32')).toBe('C:\\Users\\ana')
  })

  it('lists folders to go into, and for a program the files the host may run', () => {
    expect(pathEntries('~/', home, 'folder', 'darwin')).toEqual([
      { name: 'Pictures', kind: 'folder', path: '/Users/ana/Pictures/' },
      { name: 'projects', kind: 'folder', path: '/Users/ana/projects/' },
    ])
    expect(pathEntries('~/', home, 'program', 'darwin').map((e) => e.name)).toEqual([
      'Pictures',
      'projects',
      'run.sh',
    ])
    expect(pathEntries('~/', home, 'program', 'darwin').at(-1)?.path).toBe('/Users/ana/run.sh')
  })

  it('shows names starting with a dot once the typed part does', () => {
    const dotted = { ...home, entries: [entry('.claude'), entry('.codex')] }
    expect(pathEntries('~/', dotted, 'folder', 'darwin')).toEqual([])
    expect(pathEntries('~/.c', dotted, 'folder', 'darwin').map((e) => e.name)).toEqual([
      '.claude',
      '.codex',
    ])
  })

  it('lists at most so many entries', () => {
    const many = {
      ...home,
      entries: Array.from({ length: MAX_ENTRIES + 20 }, (_, i) => entry(`f${i}`)),
    }
    expect(pathEntries('/x/', many, 'folder', 'linux')).toHaveLength(MAX_ENTRIES)
  })

  it('names the path the text stands for from the folder the host resolved', () => {
    expect(chosenPath('~/', home, 'darwin')).toBe('/Users/ana')
    expect(chosenPath('~/projects', home, 'darwin')).toBe('/Users/ana/projects')
    expect(chosenPath('C:\\', { ...home, folder: 'C:\\' }, 'win32')).toBe('C:\\')
  })

  it('takes a folder for a folder, and only a file the host may run for a program', () => {
    expect(canChoose('folder', { kind: 'folder', executable: true })).toBe(true)
    expect(canChoose('folder', { kind: 'file', executable: true })).toBe(false)
    expect(canChoose('program', { kind: 'file', executable: true })).toBe(true)
    expect(canChoose('program', { kind: 'file', executable: false })).toBe(false)
    expect(canChoose('program', { kind: 'folder', executable: true })).toBe(false)
    expect(canChoose('folder', null)).toBe(false)
  })

  it('completes with Tab: the one entry, or the start the entries share past what was typed', () => {
    const typed = '~/pro'
    const one = { ...home, entries: [entry('projects')] }
    const oneEntries = pathEntries(typed, one, 'folder', 'darwin')
    expect(tabComplete(typed, oneEntries, one, 'darwin')).toBe('/Users/ana/projects/')
    // Once it is the entry's own path, Tab moves on.
    expect(tabComplete('/Users/ana/projects/', oneEntries, one, 'darwin')).toBeNull()

    const two = { ...home, entries: [entry('project-a'), entry('project-b')] }
    const twoEntries = pathEntries(typed, two, 'folder', 'darwin')
    expect(tabComplete(typed, twoEntries, two, 'darwin')).toBe('/Users/ana/project-')
    expect(tabComplete('~/project-', twoEntries, two, 'darwin')).toBeNull()
    expect(tabComplete(typed, [], home, 'darwin')).toBeNull()
  })
})
