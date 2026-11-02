import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '../i18n'
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
  afterEach(() => {
    setLocale('en')
  })

  const changes: PermissionUpdate[] = [
    {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }, { toolName: 'Read' }],
      behavior: 'allow',
      destination: 'projectSettings',
    },
    { type: 'addDirectories', directories: ['/tmp/x', '/tmp/y'], destination: 'session' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  ]

  it('names each change the suggestions make, and where', () => {
    expect(alwaysAllowName(changes)).toBe(
      "Always allow `npm test`, `Read` in this project's shared settings; access to `/tmp/x`, `/tmp/y` for this session; switch to Accept edits",
    )
  })

  it('separates the changes as the language does', () => {
    setLocale('zh-CN')
    expect(alwaysAllowName(changes)).toMatch(
      /^始终允许本项目的共享设置中的 `npm test`、`Read`；在本会话中访问 `\/tmp\/x`、`\/tmp\/y`；/,
    )
  })

  it('names none for a rule or folder a backtick would show wrongly', () => {
    expect(
      alwaysAllowName([
        {
          type: 'addRules',
          rules: [{ toolName: 'Read', ruleContent: '/a`b/**' }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ]),
    ).toBeNull()
    expect(
      alwaysAllowName([{ type: 'addDirectories', directories: ['/a`b'], destination: 'session' }]),
    ).toBeNull()
  })

  it('names a command rule by its command, in this project for local settings', () => {
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

  it('flags rules that hide a destructive command', () => {
    for (const content of [
      'git:*',
      'git *',
      'git -C repo reset --hard',
      'git -c x=y clean -fd',
      'git checkout -- .',
      'git restore .',
      'git push --force',
      'git branch -D main',
      'git stash clear',
      'git rm -rf .',
      'git branch:*',
      'git * --force',
      'git st*',
      'env rm -rf x',
      'command rm',
      'exec rm',
      'nohup rm',
      'time rm',
      'timeout 5 rm',
      'nice rm',
      'busybox rm',
      '"rm" -rf x',
      "'rm' -rf x",
      '(rm -rf x)',
      '{ rm -rf x; }',
      '$(rm -rf x)',
      '`rm -rf x`',
      'echo `rm -rf x`',
      'true & rm -rf x',
      '! rm x',
      'if true; then rm -rf x; fi',
      'xargs -I {} rm {}',
      'xargs -n 1 rm',
      'xargs:*',
      'find . -delete',
      'find . -exec rm {} ;',
      'find:*',
      'bash -c "rm -rf x"',
      'sh:*',
      'eval rm x',
      'npx rimraf:*',
      'pnpm exec rm:*',
    ]) {
      expect(unsafeRule(bash(content)), content).toBe(true)
    }
    expect(unsafeRule({ toolName: 'PowerShell', ruleContent: 'ri x' })).toBe(true)
    expect(unsafeRule({ toolName: 'PowerShell', ruleContent: 'Remove-Item:*' })).toBe(true)
  })

  it('passes other commands and other tools', () => {
    for (const content of [
      'pnpm dev:*',
      'pnpm dev *',
      'pnpm vitest run:*',
      'npm test',
      'git status',
      'git diff:*',
      'git -C repo log',
      'ls -la',
      'cat package.json',
    ]) {
      expect(unsafeRule(bash(content)), content).toBe(false)
    }
    expect(unsafeRule({ toolName: 'PowerShell', ruleContent: 'Get-ChildItem:*' })).toBe(false)
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

  it('leaves unsafe rules out of a replacement too', () => {
    expect(
      safeSuggestions([
        {
          type: 'replaceRules',
          rules: [
            { toolName: 'Bash', ruleContent: 'git:*' },
            { toolName: 'Bash', ruleContent: 'git status' },
          ],
          behavior: 'allow',
          destination: 'localSettings',
        },
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }],
          behavior: 'deny',
          destination: 'localSettings',
        },
      ]),
    ).toEqual([
      {
        type: 'replaceRules',
        rules: [{ toolName: 'Bash', ruleContent: 'git status' }],
        behavior: 'allow',
        destination: 'localSettings',
      },
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }],
        behavior: 'deny',
        destination: 'localSettings',
      },
    ])
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
