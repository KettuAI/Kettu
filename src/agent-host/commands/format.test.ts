import { describe, expect, it } from 'vitest'
import {
  fillCommand,
  inputHint,
  parseCommand,
  splitArguments,
  type CommandDefinition,
} from './format'

const file = `---
description: Review a file
arguments:
  - name: file
    help: The file to review
  - name: focus
    help: What to look at first
    required: false
skills: [code-review]
mcp:
  - github
---
Review {{file}}. {{focus}}
`

function read(text: string): CommandDefinition {
  const parsed = parseCommand(text)
  if (!parsed.ok) throw new Error(parsed.reason)
  return parsed.command
}

describe('reading a command file', () => {
  it('takes the description, arguments, needs and prompt', () => {
    expect(read(file)).toEqual({
      description: 'Review a file',
      arguments: [
        { name: 'file', help: 'The file to review', required: true },
        { name: 'focus', help: 'What to look at first', required: false },
      ],
      skills: ['code-review'],
      mcp: ['github'],
      body: 'Review {{file}}. {{focus}}',
    })
  })

  it('reads a file with no front matter as a prompt alone', () => {
    expect(read('Summarize the diff.\n')).toEqual({
      description: '',
      arguments: [],
      skills: [],
      mcp: [],
      body: 'Summarize the diff.',
    })
  })

  it('refuses what does not read, and says why', () => {
    const refused = (text: string) => {
      const parsed = parseCommand(text)
      return parsed.ok ? null : parsed.reason
    }
    expect(refused('---\ndescription: x\n---\n')).toMatch(/no prompt/)
    expect(refused('---\ndescription: [\n---\nbody')).toMatch(/not YAML/)
    expect(refused('---\narguments: nope\n---\nbody')).toMatch(/arguments/)
    expect(refused('---\narguments:\n  - name: 1x\n---\nbody')).toMatch(/no name/)
    expect(refused('---\narguments:\n  - name: a\n  - name: a\n---\nbody')).toMatch(/taken/)
    expect(refused('---\narguments:\n  - name: arguments\n---\nbody')).toMatch(/taken/)
    expect(refused('---\nskills: [1]\n---\nbody')).toMatch(/skills/)
    expect(refused('---\nmcp: x\n---\nbody')).toMatch(/mcp/)
  })

  it('hints the arguments, the optional ones in brackets', () => {
    expect(inputHint(read(file))).toBe('<file> [focus]')
    expect(inputHint(read('Plain.'))).toBeUndefined()
  })
})

describe('splitting what was typed after a command', () => {
  it('takes a word for each argument but the last, which takes the rest as typed', () => {
    expect(splitArguments('a.ts focus on "the cache" bugs', 2)).toEqual([
      'a.ts',
      'focus on "the cache" bugs',
    ])
    expect(splitArguments('  one two three  ', 3)).toEqual(['one', 'two', 'three'])
    expect(splitArguments('whole line as typed', 1)).toEqual(['whole line as typed'])
  })

  it('groups a quoted phrase into one word', () => {
    expect(splitArguments('"my file.ts" now', 2)).toEqual(['my file.ts', 'now'])
    expect(splitArguments("'a b' c d", 3)).toEqual(['a b', 'c', 'd'])
    // An unclosed quote is part of its word.
    expect(splitArguments('"open now', 2)).toEqual(['"open', 'now'])
  })

  it('gives fewer values than arguments when less was typed, and none for no arguments', () => {
    expect(splitArguments('only', 3)).toEqual(['only'])
    expect(splitArguments('', 2)).toEqual([])
    expect(splitArguments('ignored', 0)).toEqual([])
  })
})

describe('filling a command', () => {
  it('puts each argument and the whole line into the prompt', () => {
    const command = read('---\narguments:\n  - name: file\n---\n{{file}} / {{ arguments }}')
    expect(fillCommand(command, ' a.ts please ')).toEqual({
      ok: true,
      text: 'a.ts please / a.ts please',
    })
  })

  it('leaves an optional argument empty and a placeholder it does not know alone', () => {
    expect(fillCommand(read(file), ' a.ts')).toEqual({ ok: true, text: 'Review a.ts. ' })
    expect(fillCommand(read('Use {{nothing}} and ${HOME}.'), '')).toEqual({
      ok: true,
      text: 'Use {{nothing}} and ${HOME}.',
    })
  })

  it('names the required arguments that have no value', () => {
    expect(fillCommand(read(file), '')).toEqual({ ok: false, missing: ['file'] })
    const two = read('---\narguments:\n  - name: a\n  - name: b\n---\n{{a}}{{b}}')
    expect(fillCommand(two, 'x')).toEqual({ ok: false, missing: ['b'] })
  })

  it('does not fill in a value that holds a placeholder', () => {
    const command = read('---\narguments:\n  - name: a\n---\n{{a}}')
    expect(fillCommand(command, '{{arguments}}')).toEqual({ ok: true, text: '{{arguments}}' })
  })
})
