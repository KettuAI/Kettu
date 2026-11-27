import { describe, expect, it } from 'vitest'
import { sessionMenuGroups, type SessionMenuContext } from './session-menu-model'

const BASE_SUMMARY = {
  status: 'ready' as const,
  parentId: null,
  origin: 'user' as const,
  pr: null,
  prs: undefined,
}

const BASE_CONTEXT: SessionMenuContext = {
  canFork: true,
  local: true,
  terminal: true,
  resume: true,
}

describe('sessionMenuGroups closeTerminals item', () => {
  it('omits closeTerminals when the session has no open terminals', () => {
    const row = sessionMenuGroups(BASE_SUMMARY, { ...BASE_CONTEXT, place: 'row' }).flat()
    const more = sessionMenuGroups(BASE_SUMMARY, { ...BASE_CONTEXT, place: 'more' }).flat()
    expect(row).not.toContain('closeTerminals')
    expect(more).not.toContain('closeTerminals')
  })

  it('omits closeTerminals when terminals are not allowed on the host', () => {
    const groups = sessionMenuGroups(BASE_SUMMARY, {
      ...BASE_CONTEXT,
      place: 'more',
      terminal: false,
      hasTerminals: true,
    }).flat()
    expect(groups).not.toContain('closeTerminals')
    expect(groups).not.toContain('openTerminal')
  })

  it('places closeTerminals right after openTerminal in the header More menu when terminals exist', () => {
    const groups = sessionMenuGroups(BASE_SUMMARY, {
      ...BASE_CONTEXT,
      place: 'more',
      hasTerminals: true,
    })
    const terminalGroup = groups.find((group) => group.includes('openTerminal'))
    expect(terminalGroup).toEqual([
      'openInEditor',
      'showInFolder',
      'openTerminal',
      'closeTerminals',
    ])
  })

  it('places closeTerminals in the ending group of the sidebar row menu when terminals exist', () => {
    const groups = sessionMenuGroups(BASE_SUMMARY, {
      ...BASE_CONTEXT,
      place: 'row',
      hasTerminals: true,
    })
    const ending = groups.at(-1)
    expect(ending).toEqual(['closeTerminals', 'archive', 'delete'])
  })

  it('offers closeTerminals for a subagent only when it has open terminals', () => {
    const subagent = { ...BASE_SUMMARY, parentId: 'parent-1', origin: 'subagent' as const }
    expect(
      sessionMenuGroups(subagent, { ...BASE_CONTEXT, hasTerminals: false }).flat(),
    ).not.toContain('closeTerminals')
    expect(sessionMenuGroups(subagent, { ...BASE_CONTEXT, hasTerminals: true }).flat()).toContain(
      'closeTerminals',
    )
  })
})

describe('sessionMenuGroups copySessionId item', () => {
  it('places copySessionId right after copyResume in both row and more menus', () => {
    const rowGroup = sessionMenuGroups(BASE_SUMMARY, { ...BASE_CONTEXT, place: 'row' }).find(
      (group) => group.includes('copySessionId'),
    )
    const moreGroup = sessionMenuGroups(BASE_SUMMARY, { ...BASE_CONTEXT, place: 'more' }).find(
      (group) => group.includes('copySessionId'),
    )
    expect(rowGroup).toEqual([
      'openInSplit',
      'copyResume',
      'copySessionId',
      'showInFolder',
      'exportConversation',
    ])
    expect(moreGroup).toEqual(['copyResume', 'copySessionId', 'exportConversation'])
  })

  it('keeps copySessionId in row and more menus on web/remote hosts and without a resume command', () => {
    const remoteContext: SessionMenuContext = {
      ...BASE_CONTEXT,
      local: false,
      terminal: false,
      resume: false,
    }
    const rowGroup = sessionMenuGroups(BASE_SUMMARY, { ...remoteContext, place: 'row' }).find(
      (group) => group.includes('copySessionId'),
    )
    const moreGroup = sessionMenuGroups(BASE_SUMMARY, { ...remoteContext, place: 'more' }).find(
      (group) => group.includes('copySessionId'),
    )
    expect(rowGroup).toEqual(['openInSplit', 'copySessionId', 'exportConversation'])
    expect(moreGroup).toEqual(['copySessionId', 'exportConversation'])
  })

  it('includes copySessionId for sub-sessions and keeps subagent menus consistent across places', () => {
    const subSession = { ...BASE_SUMMARY, parentId: 'parent-1', origin: 'user' as const }
    expect(sessionMenuGroups(subSession, { ...BASE_CONTEXT, place: 'row' }).flat()).toContain(
      'copySessionId',
    )
    expect(sessionMenuGroups(subSession, { ...BASE_CONTEXT, place: 'more' }).flat()).toContain(
      'copySessionId',
    )

    const subagent = { ...BASE_SUMMARY, parentId: 'parent-1', origin: 'subagent' as const }
    expect(sessionMenuGroups(subagent, { ...BASE_CONTEXT, place: 'row' }).flat()).not.toContain(
      'copySessionId',
    )
    expect(sessionMenuGroups(subagent, { ...BASE_CONTEXT, place: 'more' }).flat()).not.toContain(
      'copySessionId',
    )
  })
})
