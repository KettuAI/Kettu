import { describe, expect, it } from 'vitest'
import { alwaysAllowName } from './permissions'

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
      'Always allow Bash(npm test:*), Read in project settings (.claude/settings.json); access to /tmp/x for this session; switch to Accept edits',
    )
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
