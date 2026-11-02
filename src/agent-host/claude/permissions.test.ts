import { describe, expect, it } from 'vitest'
import {
  alwaysAllowName,
  OPTION,
  permissionOptions,
  permissionResult,
  REJECTED,
  safeSuggestions,
  unsafeRule,
} from './permissions'
import type { PermissionUpdate } from './sdk'

describe('alwaysAllowName', () => {
  it('names each change the suggestions make, and where', () => {
    expect(
      alwaysAllowName([
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }, { toolName: 'Read' }],
          behavior: 'allow',
          destination: 'projectSettings',
        },
        { type: 'addDirectories', directories: ['/tmp/x'], destination: 'session' },
        { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      ]),
    ).toBe(
      'Always allow `npm test`, `Read` in this project; access to `/tmp/x` for this session; switch to Accept edits',
    )
  })

  it('names a command rule by its command, in this project', () => {
    expect(
      alwaysAllowName([
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'pnpm dev:*' }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ]),
    ).toBe('Always allow `pnpm dev` in this project')
  })

  it('names accepting edits for the session on its own', () => {
    expect(
      alwaysAllowName([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]),
    ).toBe('Allow all edits in this session')
  })

  it('names none for a change it cannot say truthfully', () => {
    expect(
      alwaysAllowName([
        {
          type: 'removeRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'deny',
          destination: 'userSettings',
        },
      ]),
    ).toBeNull()
    expect(alwaysAllowName([])).toBeNull()
  })
})

describe('unsafeRule', () => {
  const bash = (ruleContent?: string) => ({ toolName: 'Bash', ruleContent })

  it('flags commands that delete or gain rights, in any step', () => {
    expect(unsafeRule(bash('rm -rf node_modules/.vite && pnpm dev --port 5173'))).toBe(true)
    expect(unsafeRule(bash('sudo:*'))).toBe(true)
    expect(unsafeRule(bash('find . -name x | xargs -0 rm'))).toBe(true)
    expect(unsafeRule(bash('CI=1 /bin/rm -r out'))).toBe(true)
    expect(unsafeRule(bash('git clean:*'))).toBe(true)
    expect(unsafeRule(bash('mkfs.ext4 /dev/sda1'))).toBe(true)
    expect(unsafeRule({ toolName: 'PowerShell', ruleContent: 'Remove-Item -Recurse dist' })).toBe(
      true,
    )
  })

  it('flags a rule that would allow any command', () => {
    expect(unsafeRule(bash())).toBe(true)
    expect(unsafeRule(bash('*'))).toBe(true)
  })

  it('passes other commands and other tools', () => {
    expect(unsafeRule(bash('pnpm dev:*'))).toBe(false)
    expect(unsafeRule(bash('git status'))).toBe(false)
    expect(unsafeRule({ toolName: 'Read', ruleContent: '//tmp/**' })).toBe(false)
    expect(unsafeRule({ toolName: 'WebFetch' })).toBe(false)
  })
})

describe('safeSuggestions', () => {
  const suggestions: PermissionUpdate[] = [
    {
      type: 'addRules',
      rules: [
        { toolName: 'Bash', ruleContent: 'rm -rf node_modules/.vite:*' },
        { toolName: 'Bash', ruleContent: 'pnpm dev:*' },
      ],
      behavior: 'allow',
      destination: 'localSettings',
    },
    {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'sudo:*' }],
      behavior: 'allow',
      destination: 'localSettings',
    },
  ]

  it('keeps the safe part of a compound command, never the rm', () => {
    expect(safeSuggestions(suggestions)).toEqual([
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'pnpm dev:*' }],
        behavior: 'allow',
        destination: 'localSettings',
      },
    ])
  })

  it('offers and applies only the safe part', () => {
    const options = permissionOptions('Bash', { suggestions }, [])
    expect(options.map((o) => o.name)).toEqual([
      'Allow once',
      'Always allow `pnpm dev` in this project',
      'Deny, and say what to do instead',
    ])
    const result = permissionResult(OPTION.allowAlways, {}, { suggestions, toolUseID: 'u1' })
    expect(result).toMatchObject({
      behavior: 'allow',
      updatedPermissions: safeSuggestions(suggestions),
    })
  })

  it('offers no always-allow when nothing safe is left', () => {
    const options = permissionOptions('Bash', { suggestions: [suggestions[1]!] }, [])
    expect(options.map((o) => o.id)).toEqual([OPTION.allowOnce, OPTION.reject])
  })
})

describe('permissionOptions', () => {
  it('words an edit as the change it allows', () => {
    const options = permissionOptions(
      'Edit',
      { suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] },
      [],
    )
    expect(options.map((o) => o.name)).toEqual([
      'Allow this edit',
      'Allow all edits in this session',
      'Deny, and say what to do instead',
    ])
  })

  it('tells Claude Code to wait for the user after a denial', () => {
    expect(permissionResult(OPTION.reject, {}, { toolUseID: 'u1' })).toEqual({
      behavior: 'deny',
      message: REJECTED,
      toolUseID: 'u1',
    })
  })
})
