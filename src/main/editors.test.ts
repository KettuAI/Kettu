import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Platform } from '@shared/platform'
import { tempFolder } from '../agent-host/testing/temp'

const electron = vi.hoisted(() => ({
  /** `scheme://` -> the app registered for it. */
  schemes: new Map<string, string>(),
  lookups: [] as string[],
  getFileIcon: vi.fn(async (file: string) => ({
    isEmpty: () => false,
    toDataURL: () => `data:image/png;base64,${file}`,
  })),
  showOpenDialog: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    getApplicationInfoForProtocol: async (url: string) => {
      electron.lookups.push(url)
      const found = electron.schemes.get(url)
      if (!found) throw new Error('No app registers it')
      return { path: found, name: 'ignored', icon: {} }
    },
    getFileIcon: electron.getFileIcon,
  },
  dialog: { showOpenDialog: electron.showOpenDialog },
}))

const { customId, Editors, KNOWN_EDITORS, pathKind } = await import('./editors')

// Each rig's writes land before its folder is removed.
const made: InstanceType<typeof Editors>[] = []

afterEach(async () => {
  await Promise.all(made.splice(0).map((editors) => editors.flush()))
  electron.schemes.clear()
  electron.lookups = []
  electron.getFileIcon.mockClear()
  electron.showOpenDialog.mockReset()
})

interface Rig {
  editors: InstanceType<typeof Editors>
  /** Another run's, on the same editors.json and computer. */
  next(): InstanceType<typeof Editors>
  launched: [program: string, target: string][]
  file: string
  /** A folder that exists, to open. */
  project: string
  clock: { now: number }
}

/**
 * Editors on `platform` whose apps are `apps` (bundles on macOS, files elsewhere) and whose
 * commands are `programs`. Only the test's own folder is read from disk, so the apps installed on
 * the computer running the tests change nothing.
 */
async function rig(
  platform: Platform,
  {
    apps = [],
    programs = [],
    env = {},
    launch,
  }: {
    apps?: string[]
    programs?: string[]
    env?: Record<string, string>
    launch?: (program: string, target: string) => Promise<void>
  } = {},
): Promise<Rig> {
  const root = await tempFolder('kettu-editors-')
  const project = path.join(root, 'project')
  await mkdir(project)
  const file = path.join(root, 'editors.json')
  const launched: [string, string][] = []
  const clock = { now: 1_000 }
  const next = () => {
    const editors = new Editors({
      file,
      platform,
      home: '/Users/ana',
      env,
      kind: async (candidate) => {
        if (apps.includes(candidate)) return platform === 'darwin' ? 'directory' : 'file'
        return candidate.startsWith(root) ? pathKind(candidate) : null
      },
      isExecutable: async (candidate) => programs.includes(candidate),
      launch: async (program, target) => {
        launched.push([program, target])
        await launch?.(program, target)
      },
      now: () => clock.now,
    })
    made.push(editors)
    return editors
  }
  return { editors: next(), next, launched, file, project, clock }
}

function pick(filePath: string | null): void {
  electron.showOpenDialog.mockResolvedValueOnce(
    filePath === null
      ? { canceled: true, filePaths: [] }
      : { canceled: false, filePaths: [filePath] },
  )
}

describe('customId', () => {
  it('is the same for a path on every run, and differs between paths', () => {
    const id = customId('/Applications/Nova.app', 'darwin')
    expect(id).toMatch(/^custom:[0-9a-f]{12}$/)
    expect(customId('/Applications/Nova.app', 'darwin')).toBe(id)
    expect(customId('/Applications/Panic Nova.app', 'darwin')).not.toBe(id)
    expect(customId('/Applications/nova.app', 'darwin')).not.toBe(id)
  })

  it('ignores case on Windows only', () => {
    expect(customId('C:\\Tools\\Edit.exe', 'win32')).toBe(customId('c:\\tools\\edit.EXE', 'win32'))
  })
})

describe('Editors.list', () => {
  it("lists the known editors macOS has, in the table's order, each with its icon", async () => {
    electron.schemes.set('cursor://', '/Applications/Cursor.app')
    electron.schemes.set('vscode://', '/Applications/Visual Studio Code.app')
    const { editors } = await rig('darwin', {
      apps: [
        '/Users/ana/Applications/Zed.app', // the scheme is not registered, the bundle is there
        '/Applications/Xcode.app',
        '/Applications/IntelliJ IDEA Ultimate.app',
        '/Applications/Fleet', // not a bundle
      ],
    })

    const list = await editors.list()

    expect(list.editors.map((editor) => editor.id)).toEqual([
      'vscode',
      'cursor',
      'zed',
      'xcode',
      'intellij-idea',
    ])
    expect(list.editors[0]).toEqual({
      id: 'vscode',
      name: 'Visual Studio Code',
      icon: 'data:image/png;base64,/Applications/Visual Studio Code.app',
    })
    expect(list.editors[2]!.icon).toBe('data:image/png;base64,/Users/ana/Applications/Zed.app')
    expect(list.last).toBeNull()
    expect(electron.getFileIcon).toHaveBeenCalledWith('/Applications/Cursor.app', {
      size: 'normal',
    })
  })

  it('looks up only the editors with a scheme on Windows', async () => {
    electron.schemes.set('zed://', 'C:\\Program Files\\Zed\\Zed.exe')
    const { editors } = await rig('win32')

    expect((await editors.list()).editors).toEqual([
      { id: 'zed', name: 'Zed', icon: 'data:image/png;base64,C:\\Program Files\\Zed\\Zed.exe' },
    ])
    const schemed = KNOWN_EDITORS.filter((editor) => editor.scheme)
    expect(electron.lookups).toHaveLength(schemed.length)
  })

  it('finds the commands on PATH on Linux, with no icons', async () => {
    const { editors } = await rig('linux', {
      env: { PATH: '/usr/bin:/home/ana/.local/bin' },
      programs: ['/home/ana/.local/bin/zed', '/usr/bin/code', '/usr/bin/idea', '/usr/bin/xcode'],
    })

    expect((await editors.list()).editors).toEqual([
      { id: 'vscode', name: 'Visual Studio Code', icon: null },
      { id: 'zed', name: 'Zed', icon: null },
      { id: 'intellij-idea', name: 'IntelliJ IDEA', icon: null },
    ])
    expect(electron.getFileIcon).not.toHaveBeenCalled()
    expect(electron.lookups).toEqual([])
  })

  it('lists an app two schemes lead to once', async () => {
    electron.schemes.set('vscode://', '/Applications/Visual Studio Code.app')
    electron.schemes.set('vscode-insiders://', '/Applications/Visual Studio Code.app')
    const { editors } = await rig('darwin')

    expect((await editors.list()).editors.map((editor) => editor.id)).toEqual(['vscode'])
  })

  it('looks again only once a minute has passed', async () => {
    electron.schemes.set('cursor://', '/Applications/Cursor.app')
    const { editors, clock } = await rig('darwin')
    await editors.list()
    const first = electron.lookups.length

    electron.schemes.set('zed://', '/Applications/Zed.app')
    clock.now += 59_000
    expect((await editors.list()).editors.map((editor) => editor.id)).toEqual(['cursor'])
    expect(electron.lookups).toHaveLength(first)

    clock.now += 1_000
    expect((await editors.list()).editors.map((editor) => editor.id)).toEqual(['cursor', 'zed'])
    expect(electron.lookups).toHaveLength(first * 2)
  })

  it('reads an icon once per app', async () => {
    electron.schemes.set('cursor://', '/Applications/Cursor.app')
    const { editors, clock } = await rig('darwin')
    await editors.list()
    clock.now += 120_000
    await editors.list()

    expect(electron.getFileIcon).toHaveBeenCalledTimes(1)
  })

  it('shows no icon when the app has none', async () => {
    electron.schemes.set('cursor://', '/Applications/Cursor.app')
    electron.getFileIcon.mockRejectedValueOnce(new Error('No icon'))
    const { editors } = await rig('darwin')

    expect((await editors.list()).editors[0]!.icon).toBeNull()
  })

  it('drops what editors.json holds that main never wrote, and apps that are gone', async () => {
    const { editors, file } = await rig('darwin', { apps: ['/Applications/Nova Two.app'] })
    await writeFile(
      file,
      JSON.stringify({
        last: 'custom:000000000000',
        custom: [
          { id: 'custom:000000000000', name: 'Nova Two', path: '/Applications/Nova Two.app' },
          { id: 'vscode', name: 'Relative', path: 'Relative.app' },
          { id: 'x', name: 'Gone', path: '/Applications/Gone.app' },
          'not an entry',
        ],
      }),
    )

    expect(await editors.list()).toEqual({
      editors: [
        {
          id: customId('/Applications/Nova Two.app', 'darwin'),
          name: 'Nova Two',
          icon: 'data:image/png;base64,/Applications/Nova Two.app',
        },
      ],
      // The id main would never have written names no listed editor.
      last: null,
    })
  })
})

describe('Editors.open', () => {
  it('opens a folder in a listed editor and remembers it as the last one', async () => {
    electron.schemes.set('cursor://', '/Applications/Cursor.app')
    const { editors, launched, project, file } = await rig('darwin')

    await editors.open('cursor', project)

    expect(launched).toEqual([['/Applications/Cursor.app', project]])
    expect((await editors.list()).last).toBe('cursor')
    await editors.flush()
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ last: 'cursor', custom: [] })
  })

  it('opens a file too', async () => {
    electron.schemes.set('zed://', '/Applications/Zed.app')
    const { editors, launched, project } = await rig('darwin')
    const notes = path.join(project, 'notes.md')
    await writeFile(notes, '# Notes\n')

    await editors.open('zed', notes)

    expect(launched).toEqual([['/Applications/Zed.app', notes]])
  })

  it('reads the last editor back on the next run', async () => {
    electron.schemes.set('cursor://', '/Applications/Cursor.app')
    const { editors, next, project } = await rig('darwin')
    await editors.open('cursor', project)
    await editors.flush()

    expect((await next().list()).last).toBe('cursor')
  })

  it.each([
    ['a relative path', 'cursor', 'project'],
    ['an empty path', 'cursor', ''],
    ['a path that is not a string', 'cursor', 42],
    ['a path with a NUL character', 'cursor', '/tmp/a\0b'],
    ['a path that does not exist', 'cursor', '/no/such/folder/anywhere'],
    ['an editor that is not installed', 'zed', null],
    ['an unknown id', 'emacs', null],
    ['an app path in place of an id', '/Applications/Cursor.app', null],
    ['an id that is not a string', 7, null],
  ])('refuses %s', async (_, editorId, target) => {
    electron.schemes.set('cursor://', '/Applications/Cursor.app')
    const { editors, launched, project } = await rig('darwin')

    await expect(editors.open(editorId, target ?? project)).rejects.toThrow()
    expect(launched).toEqual([])
    expect((await editors.list()).last).toBeNull()
  })

  it('refuses a path longer than any system allows', async () => {
    electron.schemes.set('cursor://', '/Applications/Cursor.app')
    const { editors } = await rig('darwin')

    await expect(editors.open('cursor', `/${'a'.repeat(4096)}`)).rejects.toThrow(/1 to 4096/)
  })

  it('says why the editor did not start, and keeps the last one as it was', async () => {
    electron.schemes.set('cursor://', '/Applications/Cursor.app')
    const { editors, project } = await rig('darwin', {
      launch: async () => {
        throw new Error('LSOpenURLsWithRole() failed')
      },
    })

    await expect(editors.open('cursor', project)).rejects.toThrow(
      'Could not open it in Cursor: LSOpenURLsWithRole() failed',
    )
    expect((await editors.list()).last).toBeNull()
  })
})

describe('Editors.choose', () => {
  it('asks for an app in /Applications on macOS, attached to the window', async () => {
    const { editors, project } = await rig('darwin')
    const window = { id: 3 } as unknown as Electron.BrowserWindow
    pick(null)

    expect(await editors.choose(window, project)).toBeNull()
    expect(electron.showOpenDialog).toHaveBeenCalledWith(
      window,
      expect.objectContaining({
        defaultPath: '/Applications',
        filters: [expect.objectContaining({ extensions: ['app'] })],
      }),
    )
  })

  it('asks for an .exe on Windows', async () => {
    const { editors, project } = await rig('win32')
    pick(null)

    await editors.choose(null, project)

    expect(electron.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({ filters: [expect.objectContaining({ extensions: ['exe'] })] }),
    )
  })

  it('opens the path in the app chosen, which the list offers after the known ones', async () => {
    electron.schemes.set('cursor://', '/Applications/Cursor.app')
    const { editors, launched, project } = await rig('darwin', {
      apps: ['/Applications/CotEditor.app'],
    })
    pick('/Applications/CotEditor.app')

    const chosen = await editors.choose(null, project)

    const cotEditor = {
      id: customId('/Applications/CotEditor.app', 'darwin'),
      name: 'CotEditor',
      icon: 'data:image/png;base64,/Applications/CotEditor.app',
    }
    expect(chosen).toEqual(cotEditor)
    expect(launched).toEqual([['/Applications/CotEditor.app', project]])
    const list = await editors.list()
    expect(list.editors.map((editor) => editor.id)).toEqual(['cursor', cotEditor.id])
    expect(list.last).toBe(cotEditor.id)

    await editors.open(cotEditor.id, project)
    expect(launched).toHaveLength(2)
  })

  it('gives a known editor chosen in the dialog its own id', async () => {
    electron.schemes.set('cursor://', '/Applications/Cursor.app')
    const { editors, project } = await rig('darwin', { apps: ['/Applications/Cursor.app'] })
    pick('/Applications/Cursor.app')

    expect(await editors.choose(null, project)).toMatchObject({ id: 'cursor', name: 'Cursor' })
    expect(await editors.list()).toMatchObject({ editors: [{ id: 'cursor' }], last: 'cursor' })
  })

  it('keeps the 10 apps chosen last, the latest first, each once', async () => {
    const apps = Array.from({ length: 12 }, (_, index) => `/Applications/App ${index}.app`)
    const { editors, project, file } = await rig('darwin', { apps })
    for (const app of apps) {
      pick(app)
      await editors.choose(null, project)
    }
    pick(apps[5]!)
    await editors.choose(null, project)

    const names = (await editors.list()).editors.map((editor) => editor.name)
    expect(names).toEqual([
      'App 5',
      'App 11',
      'App 10',
      'App 9',
      'App 8',
      'App 7',
      'App 6',
      'App 4',
      'App 3',
      'App 2',
    ])
    await editors.flush()
    const saved = JSON.parse(await readFile(file, 'utf8')) as {
      last: string
      custom: { id: string; name: string; path: string }[]
    }
    expect(saved.last).toBe(customId(apps[5]!, 'darwin'))
    expect(saved.custom).toHaveLength(10)
    expect(saved.custom[0]).toEqual({
      id: customId(apps[5]!, 'darwin'),
      name: 'App 5',
      path: apps[5],
    })
  })

  it.each<[string, Platform, string, string[], string[]]>([
    ['a folder that is not a bundle on macOS', 'darwin', '/Applications/Tools', [], []],
    ['an app that is not there on macOS', 'darwin', '/Applications/Gone.app', [], []],
    [
      'a program that is not an .exe on Windows',
      'win32',
      'C:\\Tools\\edit.bat',
      ['C:\\Tools\\edit.bat'],
      [],
    ],
    ['a file that cannot be run on Linux', 'linux', '/home/ana/notes.txt', [], []],
  ])('refuses %s', async (_, platform, picked, apps, programs) => {
    const { editors, launched, project } = await rig(platform, { apps, programs })
    pick(picked)

    await expect(editors.choose(null, project)).rejects.toThrow(/not an app/)
    expect(launched).toEqual([])
    expect((await editors.list()).editors).toEqual([])
  })

  it('takes a program that can be run on Linux', async () => {
    const { editors, launched, project } = await rig('linux', { programs: ['/opt/helix/hx'] })
    pick('/opt/helix/hx')

    expect(await editors.choose(null, project)).toEqual({
      id: customId('/opt/helix/hx', 'linux'),
      name: 'hx',
      icon: null,
    })
    expect(launched).toEqual([['/opt/helix/hx', project]])
  })

  it('refuses a path that is not absolute before asking', async () => {
    const { editors } = await rig('darwin')

    await expect(editors.choose(null, 'project')).rejects.toThrow(/absolute/)
    expect(electron.showOpenDialog).not.toHaveBeenCalled()
  })

  it('remembers no app that did not start', async () => {
    const { editors, project } = await rig('darwin', {
      apps: ['/Applications/CotEditor.app'],
      launch: async () => {
        throw new Error('The application cannot be opened')
      },
    })
    pick('/Applications/CotEditor.app')

    await expect(editors.choose(null, project)).rejects.toThrow(/Could not open it in CotEditor/)
    expect(await editors.list()).toEqual({ editors: [], last: null })
  })
})
