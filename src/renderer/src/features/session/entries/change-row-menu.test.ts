import { describe, expect, it } from 'vitest'
import { changeRowMenuModel, isChangeDeleted } from './change-row-menu'

const LOCAL_PROJECT = '/Users/dev/app'
const REMOTE_PROJECT = 'kettu-host:0123456789abcdef0123456789abcdef:/home/dev/app'

describe('changeRowMenuModel', () => {
  it('enables editor, file manager, Files pane, and both copy actions for a local project file', () => {
    expect(
      changeRowMenuModel({
        projectPath: LOCAL_PROJECT,
        path: '/Users/dev/app/src/button.tsx',
        local: true,
        deleted: false,
      }),
    ).toEqual({
      localTarget: '/Users/dev/app/src/button.tsx',
      filesTarget: 'src/button.tsx',
      copyPath: '/Users/dev/app/src/button.tsx',
      copyRelativePath: 'src/button.tsx',
    })
  })

  it('resolves a relative diff path against the project root for editor and file manager targets', () => {
    expect(
      changeRowMenuModel({
        projectPath: 'C:\\Work\\App',
        path: 'src/button.tsx',
        local: true,
        deleted: false,
      }),
    ).toEqual({
      localTarget: 'C:\\Work\\App\\src\\button.tsx',
      filesTarget: 'src/button.tsx',
      copyPath: 'C:\\Work\\App\\src\\button.tsx',
      copyRelativePath: 'src/button.tsx',
    })
  })

  it('hides local editor and file manager actions for remote projects while keeping Files and copy actions', () => {
    expect(
      changeRowMenuModel({
        projectPath: REMOTE_PROJECT,
        path: '/home/dev/app/src/button.tsx',
        local: false,
        deleted: false,
      }),
    ).toEqual({
      localTarget: null,
      filesTarget: 'src/button.tsx',
      copyPath: '/home/dev/app/src/button.tsx',
      copyRelativePath: 'src/button.tsx',
    })
  })

  it('hides editor, file manager, and Files actions for deleted files while keeping copy actions', () => {
    expect(
      changeRowMenuModel({
        projectPath: LOCAL_PROJECT,
        path: '/Users/dev/app/src/removed.ts',
        local: true,
        deleted: true,
      }),
    ).toEqual({
      localTarget: null,
      filesTarget: null,
      copyPath: '/Users/dev/app/src/removed.ts',
      copyRelativePath: 'src/removed.ts',
    })
  })

  it('hides Files and relative copy actions for files outside the project', () => {
    expect(
      changeRowMenuModel({
        projectPath: LOCAL_PROJECT,
        path: '/tmp/scratch.txt',
        local: true,
        deleted: false,
      }),
    ).toEqual({
      localTarget: '/tmp/scratch.txt',
      filesTarget: null,
      copyPath: '/tmp/scratch.txt',
      copyRelativePath: null,
    })
  })

  it('hides local open actions for unexpanded home paths while keeping Copy path', () => {
    expect(
      changeRowMenuModel({
        projectPath: LOCAL_PROJECT,
        path: '~/notes.txt',
        local: true,
        deleted: false,
      }),
    ).toEqual({
      localTarget: null,
      filesTarget: null,
      copyPath: '~/notes.txt',
      copyRelativePath: null,
    })
  })
})

describe('isChangeDeleted', () => {
  it('returns true when the turn deleted the file', () => {
    expect(
      isChangeDeleted({
        changeDeleted: true,
        path: '/Users/dev/app/src/a.ts',
        projectPath: LOCAL_PROJECT,
        repoRoot: null,
        gitDeleted: new Set(),
      }),
    ).toBe(true)
  })

  it('returns true when git reports the file as deleted, even for a project inside a repo subfolder', () => {
    expect(
      isChangeDeleted({
        changeDeleted: false,
        path: '/Users/dev/mono/packages/app/src/old.ts',
        projectPath: '/Users/dev/mono/packages/app',
        repoRoot: '/Users/dev/mono',
        gitDeleted: new Set(['packages/app/src/old.ts']),
      }),
    ).toBe(true)

    expect(
      isChangeDeleted({
        changeDeleted: false,
        path: 'src/old.ts',
        projectPath: '/Users/dev/mono/packages/app',
        repoRoot: '/Users/dev/mono',
        gitDeleted: new Set(['packages/app/src/old.ts']),
      }),
    ).toBe(true)
  })

  it('returns false when neither the turn nor git marks the file deleted', () => {
    expect(
      isChangeDeleted({
        changeDeleted: false,
        path: '/Users/dev/app/src/live.ts',
        projectPath: LOCAL_PROJECT,
        repoRoot: LOCAL_PROJECT,
        gitDeleted: new Set(['src/other.ts']),
      }),
    ).toBe(false)
  })
})
