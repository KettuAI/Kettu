import { describe, expect, it } from 'vitest'
import type { SlashCommand } from '@shared/thread'
import { leadingCommand, orderSlashMatches } from './slash'

const command = (name: string): SlashCommand => ({ name, description: '' })
const names = (list: SlashCommand[]) => list.map((c) => c.name)

describe('orderSlashMatches', () => {
  const commands = [
    'compact',
    'code-review',
    'review',
    'init',
    'rewind',
    'pr-review',
    'resume',
  ].map(command)

  it('puts names that start with the query before those that only contain it', () => {
    expect(names(orderSlashMatches(commands, 're'))).toEqual([
      'review',
      'rewind',
      'resume',
      'code-review',
      'pr-review',
    ])
  })

  it('keeps the agent order within each group', () => {
    expect(names(orderSlashMatches(commands, 'i'))).toEqual([
      'init',
      'code-review',
      'review',
      'rewind',
      'pr-review',
    ])
  })

  it('ignores case in the query and the name', () => {
    expect(names(orderSlashMatches([command('Review'), command('prReview')], 'REV'))).toEqual([
      'Review',
      'prReview',
    ])
  })

  it('returns every command for an empty query, in the agent order', () => {
    expect(names(orderSlashMatches(commands, ''))).toEqual(names(commands))
  })

  it('returns nothing when no name holds the query', () => {
    expect(orderSlashMatches(commands, 'zzz')).toEqual([])
  })
})

describe('leadingCommand', () => {
  const list = ['goal', 'compact', 'plugin:run']

  it('gives the length of the command the draft starts with', () => {
    expect(leadingCommand('/goal', list)).toBe(5)
    expect(leadingCommand('/goal x', list)).toBe(5)
    expect(leadingCommand('/goal\nthe rest', list)).toBe(5)
  })

  it('matches a name with a colon whole', () => {
    expect(leadingCommand('/plugin:run now', list)).toBe(11)
    expect(leadingCommand('/plugin now', list)).toBe(0)
  })

  it('leaves other names, other cases and names that run on unmarked', () => {
    expect(leadingCommand('/goals', list)).toBe(0)
    expect(leadingCommand('/Goal', list)).toBe(0)
    expect(leadingCommand('/goal,', list)).toBe(0)
  })

  it('marks only a command that starts the draft', () => {
    expect(leadingCommand(' /goal', list)).toBe(0)
    expect(leadingCommand('x /goal', list)).toBe(0)
    expect(leadingCommand('/', list)).toBe(0)
  })

  it('marks nothing before the agent lists its commands', () => {
    expect(leadingCommand('/goal', [])).toBe(0)
  })
})
