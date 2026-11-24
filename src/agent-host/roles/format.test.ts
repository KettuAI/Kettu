import { describe, expect, it } from 'vitest'
import { parseRole, roleBlock } from './format'

const file = `---
name: Release manager
description: Cuts a release
agent: claude-code
model: opus
effort: high
skills: [changelog-writer]
mcp:
  - github
---
You prepare releases.
`

describe('reading a role file', () => {
  it('takes the name, description, suggestions, needs and instructions', () => {
    expect(parseRole(file)).toEqual({
      ok: true,
      role: {
        title: 'Release manager',
        description: 'Cuts a release',
        suggests: { agent: 'claude-code', model: 'opus', effort: 'high' },
        needs: { skills: ['changelog-writer'], mcp: ['github'] },
        body: 'You prepare releases.',
      },
    })
  })

  it('reads a file with no front matter as instructions alone', () => {
    expect(parseRole('Review the change.\n')).toEqual({
      ok: true,
      role: {
        description: '',
        suggests: {},
        needs: { skills: [], mcp: [] },
        body: 'Review the change.',
      },
    })
  })

  it('refuses a file with no instructions, or a front matter that does not read', () => {
    expect(parseRole('---\nname: Empty\n---\n  \n')).toEqual({
      ok: false,
      reason: 'it has no instructions',
    })
    expect(parseRole('---\nagent: [a]\n---\nBody')).toEqual({
      ok: false,
      reason: 'agent is not text',
    })
    expect(parseRole('---\nskills: nope\n---\nBody')).toMatchObject({ ok: false })
    expect(parseRole('---\n- a\n---\nBody')).toEqual({
      ok: false,
      reason: 'the front matter is not a map',
    })
  })

  it('writes the instructions as a block that names the role without breaking out of it', () => {
    expect(roleBlock('Release manager', 'Do it.')).toBe(
      '<kettu-role name="Release manager">\nDo it.\n</kettu-role>',
    )
    expect(roleBlock('A"><x', 'Do it.')).toBe('<kettu-role name="A   x">\nDo it.\n</kettu-role>')
  })
})
