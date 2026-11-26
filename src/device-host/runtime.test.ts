import { describe, expect, it } from 'vitest'
import { nodeCommand } from './runtime'

describe('nodeCommand', () => {
  it('resolves the macOS Helper binary and sets ELECTRON_RUN_AS_NODE under Electron', () => {
    const mainExec = '/Applications/Kettu.app/Contents/MacOS/Kettu'
    const helperExec =
      '/Applications/Kettu.app/Contents/Frameworks/Kettu Helper.app/Contents/MacOS/Kettu Helper'

    expect(
      nodeCommand(
        { PATH: '/usr/bin' },
        {
          isElectron: true,
          execPath: mainExec,
          platform: 'darwin',
          exists: (file) => file === helperExec,
        },
      ),
    ).toEqual({
      file: helperExec,
      env: { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' },
    })
  })

  it('falls back to execPath under Electron when the macOS Helper binary is missing', () => {
    const mainExec = '/Applications/Kettu.app/Contents/MacOS/Kettu'

    expect(
      nodeCommand(
        { PATH: '/usr/bin' },
        {
          isElectron: true,
          execPath: mainExec,
          platform: 'darwin',
          exists: () => false,
        },
      ),
    ).toEqual({
      file: mainExec,
      env: { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' },
    })
  })

  it('leaves standalone Node.js untouched without injecting ELECTRON_RUN_AS_NODE', () => {
    const env = { PATH: '/usr/bin' }

    expect(
      nodeCommand(env, {
        isElectron: false,
        execPath: '/opt/homebrew/bin/node',
        platform: 'darwin',
        exists: () => true,
      }),
    ).toEqual({
      file: '/opt/homebrew/bin/node',
      env,
    })
  })
})
