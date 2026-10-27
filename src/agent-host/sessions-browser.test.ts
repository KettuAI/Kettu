import { describe, expect, it } from 'vitest'
import { sessionWithPage } from './sessions'

interface Record {
  id: string
  origin: 'user' | 'subagent' | 'routine'
  parentId: string | null
}

function records(...items: Record[]): (id: string) => Record | undefined {
  const byId = new Map(items.map((item) => [item.id, item]))
  return (id) => byId.get(id)
}

describe('sessionWithPage', () => {
  it('is the session itself when it has a page of its own', () => {
    const record = { id: 'top', origin: 'user' as const, parentId: null }
    expect(sessionWithPage(record, records(record)).id).toBe('top')
  })

  it('walks a subagent up to the top-level session it runs under', () => {
    const top = { id: 'top', origin: 'user' as const, parentId: null }
    const child = { id: 'child', origin: 'subagent' as const, parentId: 'top' }
    const grandchild = { id: 'grandchild', origin: 'subagent' as const, parentId: 'child' }
    const find = records(top, child, grandchild)
    expect(sessionWithPage(child, find).id).toBe('top')
    expect(sessionWithPage(grandchild, find).id).toBe('top')
  })

  it('stops at a parent it cannot find, and never loops on a cycle', () => {
    const orphan = { id: 'orphan', origin: 'subagent' as const, parentId: 'gone' }
    expect(sessionWithPage(orphan, records(orphan)).id).toBe('orphan')
    const a = { id: 'a', origin: 'subagent' as const, parentId: 'b' }
    const b = { id: 'b', origin: 'subagent' as const, parentId: 'a' }
    expect(sessionWithPage(a, records(a, b)).id).toMatch(/^[ab]$/)
  })
})
