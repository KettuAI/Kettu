import { describe, expect, it } from 'vitest'
import { COMPUTER_TOOL_NAMES } from '@shared/computer-use'
import type { Platform } from '@shared/platform'
import { driverEnv } from './driver'
import { COMPUTER_TOOLS, ComputerToolError, computerCall } from './tools'

function refused(name: string, input: unknown, platform: Platform = 'darwin'): string {
  try {
    computerCall(name, input, platform)
  } catch (error) {
    expect(error).toBeInstanceOf(ComputerToolError)
    expect((error as ComputerToolError).code).toBe('invalid')
    return (error as Error).message
  }
  throw new Error(`${name} was accepted`)
}

describe('the computer tools', () => {
  it('lists a schema for every tool name', () => {
    expect(COMPUTER_TOOLS.map((tool) => tool.name)).toEqual([...COMPUTER_TOOL_NAMES])
  })

  it('aims every action at the window it names', () => {
    expect(
      computerCall(
        'computer_click',
        { pid: 42, window_id: 7, element_token: 's0000002a:11' },
        'darwin',
      ),
    ).toEqual({
      tool: 'computer_click',
      driverTool: 'click',
      args: {
        target: { kind: 'window', pid: 42, window_id: 7 },
        delivery_mode: 'background',
        element_token: 's0000002a:11',
      },
      pid: 42,
      acts: true,
      elementToken: 's0000002a:11',
    })
    expect(
      computerCall('computer_type_text', { pid: 42, window_id: 7, text: 'hello' }, 'linux').args,
    ).toEqual({ target: { kind: 'window', pid: 42, window_id: 7 }, text: 'hello' })
    expect(
      computerCall(
        'computer_invoke_menu',
        { pid: 3, window_id: 1, path: ['File', 'Save'] },
        'win32',
      ),
    ).toMatchObject({
      args: { pid: 3, window_id: 1, path: ['File', 'Save'] },
      menuPath: ['File', 'Save'],
    })
  })

  it('reads the app it lists windows of, and lists apps without one', () => {
    expect(computerCall('computer_list_apps', {}, 'darwin')).toMatchObject({
      pid: null,
      acts: false,
    })
    expect(computerCall('computer_list_windows', { pid: 9 }, 'darwin')).toMatchObject({
      args: { pid: 9 },
      pid: 9,
      acts: false,
    })
  })

  it('collects the keys a press makes for the refused shortcuts', () => {
    expect(
      computerCall(
        'computer_press_key',
        { pid: 1, window_id: 2, key: 'q', modifiers: ['cmd'] },
        'darwin',
      ).keys,
    ).toEqual(['cmd', 'q'])
    expect(
      computerCall('computer_hotkey', { pid: 1, window_id: 2, keys: ['cmd', 'q'] }, 'darwin').keys,
    ).toEqual(['cmd', 'q'])
  })

  it('passes no argument the driver would take beyond the schema', () => {
    for (const extra of [
      { screenshot_out_file: '/tmp/x.png' },
      { debug_image_out: '/tmp/x.png' },
      { scope: 'desktop' },
      { session: 'other' },
      { target: { kind: 'desktop', display_id: 'primary' } },
    ]) {
      refused('computer_click', { pid: 1, window_id: 2, x: 3, y: 4, ...extra })
    }
    refused('computer_get_window_state', { pid: 1, window_id: 2, full_output: true })
  })

  it('checks each argument as its schema says', () => {
    refused('computer_list_windows', {})
    refused('computer_list_windows', { pid: 0 })
    refused('computer_list_windows', { pid: 1.5 })
    refused('computer_get_window_state', { pid: 1 })
    refused('computer_get_window_state', {
      pid: 1,
      window_id: 2,
      include_screenshot: false,
      include_accessibility_tree: false,
    })
    refused('computer_click', { pid: 1, window_id: 2 })
    refused('computer_click', { pid: 1, window_id: 2, x: 3 })
    refused('computer_click', { pid: 1, window_id: 2, element_token: 's0000002a:1', x: 1, y: 1 })
    refused('computer_click', { pid: 1, window_id: 2, element_token: 'e12' })
    refused('computer_click', { pid: 1, window_id: 2, x: -1, y: 1 })
    refused('computer_click', { pid: 1, window_id: 2, x: 1, y: 1, delivery_mode: 'global' })
    refused('computer_type_text', { pid: 1, window_id: 2, text: 'x'.repeat(20_001) })
    refused('computer_press_key', { pid: 1, window_id: 2, key: ' ' })
    refused('computer_press_key', { pid: 1, window_id: 2, key: 'a', modifiers: ['hyper'] })
    refused('computer_hotkey', { pid: 1, window_id: 2, keys: ['cmd'] })
    refused('computer_scroll', { pid: 1, window_id: 2, x: 1, y: 1 })
    refused('computer_invoke_menu', { pid: 1, window_id: 2, path: [] })
    refused('computer_list_apps', 'all')
    refused('computer_open_terminal', {})
  })

  it('types into an element by its token on macOS only', () => {
    expect(
      computerCall(
        'computer_type_text',
        { pid: 1, window_id: 2, text: 'x', element_token: 's0000002a:3' },
        'darwin',
      ).elementToken,
    ).toBe('s0000002a:3')
    expect(
      refused(
        'computer_type_text',
        { pid: 1, window_id: 2, text: 'x', element_token: 's0000002a:3' },
        'win32',
      ),
    ).toMatch(/only on macOS/)
  })
})

describe('the driver environment', () => {
  it('keeps the driver embedded, off the network and out of the unrestricted mode', () => {
    const env = driverEnv({
      DISPLAY: ':0',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      CUA_DRIVER_PERMISSION_MODE: 'unrestricted',
      CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS: '1',
      CUA_HOME: '/somewhere',
      DO_NOT_TRACK: '0',
      ANTHROPIC_API_KEY: 'secret',
    })
    expect(env).toEqual({
      DISPLAY: ':0',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      CUA_DRIVER_EMBEDDED: '1',
      DO_NOT_TRACK: '1',
      CUA_DRIVER_RS_UPDATE_CHECK: 'false',
      CUA_DRIVER_DISABLE_UNRESTRICTED: '1',
    })
  })

  it('turns on the native Wayland backend on a Wayland desktop', () => {
    expect(driverEnv({ XDG_SESSION_TYPE: 'wayland' }).CUA_DRIVER_RS_ENABLE_WAYLAND).toBe('1')
    expect(driverEnv({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' })).not.toHaveProperty(
      'CUA_DRIVER_RS_ENABLE_WAYLAND',
    )
  })
})
