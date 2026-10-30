import { describe, expect, it } from 'vitest'
import { fenced, resultContent, toolView } from './tools'

describe('toolView', () => {
  it('titles a tool call by what it does, relative to the session folder', () => {
    expect(
      toolView('Read', { file_path: '/repo/src/a.ts', offset: 10, limit: 5 }, '/repo'),
    ).toEqual({
      title: 'Read src/a.ts (10 - 14)',
      toolKind: 'read',
      locations: [{ path: '/repo/src/a.ts', line: 10 }],
      content: [],
    })
    expect(
      toolView('Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' }, '/repo'),
    ).toMatchObject({
      title: 'Edit a.ts',
      toolKind: 'edit',
      content: [{ type: 'diff', path: '/repo/a.ts', oldText: 'a', newText: 'b' }],
    })
    expect(toolView('Grep', { pattern: 'todo', '-i': true, glob: '*.ts' }, '/repo').title).toBe(
      'grep -i --include="*.ts" "todo"',
    )
    expect(toolView('WebSearch', { query: 'acp' }, '/repo')).toMatchObject({
      title: 'Search "acp"',
      toolKind: 'fetch',
    })
    expect(toolView('mcp__kettu__show', {}, '/repo')).toMatchObject({
      title: 'mcp__kettu__show',
      toolKind: 'other',
    })
  })
})

describe('resultContent', () => {
  it("shows a Write's original text once Claude Code names it", () => {
    const before = toolView('Write', { file_path: '/repo/a.ts', content: 'new' }, '/repo').content
    expect(
      resultContent(
        'Write',
        { type: 'tool_result', tool_use_id: 't' },
        { originalFile: 'old' },
        before,
      ),
    ).toEqual([{ type: 'diff', path: '/repo/a.ts', oldText: 'old', newText: 'new' }])
  })

  it('fences an error, and drops the reminders Claude Code adds for the model', () => {
    expect(
      resultContent(
        'Grep',
        { type: 'tool_result', tool_use_id: 't', is_error: true, content: 'No such file' },
        undefined,
        [],
      ),
    ).toEqual([{ type: 'markdown', markdown: '```\nNo such file\n```' }])
    expect(
      resultContent(
        'Glob',
        {
          type: 'tool_result',
          tool_use_id: 't',
          content: 'a.ts\n<system-reminder>x</system-reminder>',
        },
        undefined,
        [],
      ),
    ).toEqual([{ type: 'markdown', markdown: 'a.ts' }])
  })

  it('fences text that holds a fence with a longer one', () => {
    expect(fenced('```\nx\n```')).toBe('````\n```\nx\n```\n````')
  })
})
