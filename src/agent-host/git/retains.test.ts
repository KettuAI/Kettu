import { describe, expect, it } from 'vitest'
import { GitRetains } from './retains'

describe('GitRetains', () => {
  it('keeps a port retained while any of its watchers of the project remains', () => {
    const retains = new GitRetains()
    expect(retains.add('p', '/repo', 'port', 'files')).toBe(true)
    expect(retains.add('p', '/repo', 'port', 'changes')).toBe(false)
    expect(retains.remove('p', 'port', 'files')).toBeNull()
    expect([...retains.ports('p')]).toEqual(['port'])
    expect(retains.remove('p', 'port', 'changes')).toBe('/repo')
    expect([...retains.ports('p')]).toEqual([])
  })

  it('counts a watcher once, however often it asks', () => {
    const retains = new GitRetains()
    retains.add('p', '/repo', 'port', 'files')
    retains.add('p', '/repo', 'port', 'files')
    expect(retains.remove('p', 'port', 'files')).toBe('/repo')
  })

  it('ignores an unwatch from a watcher that never watched', () => {
    const retains = new GitRetains()
    retains.add('p', '/repo', 'port', 'files')
    expect(retains.remove('p', 'port', 'other')).toBeNull()
    expect(retains.remove('p', 'other-port', 'files')).toBeNull()
    expect([...retains.ports('p')]).toEqual(['port'])
  })

  it('keeps other ports of the project when one lets go', () => {
    const retains = new GitRetains()
    retains.add('p', '/repo', 'one', '')
    retains.add('p', '/repo', 'two', '')
    expect(retains.remove('p', 'one', '')).toBe('/repo')
    expect([...retains.ports('p')]).toEqual(['two'])
  })

  it('forgets a closed port in every project', () => {
    const retains = new GitRetains()
    retains.add('a', '/a', 'port', 'x')
    retains.add('a', '/a', 'port', 'y')
    retains.add('b', '/b', 'port', 'x')
    retains.add('b', '/b', 'other', 'x')
    retains.dropPort('port')
    expect([...retains.ports('a')]).toEqual([])
    expect([...retains.ports('b')]).toEqual(['other'])
  })
})
