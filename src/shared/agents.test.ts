import { describe, expect, it } from 'vitest'
import {
  addedAgentId,
  harnessOf,
  isAgentId,
  isDefaultAgent,
  isFullAccessMode,
  isHarnessId,
  isStartMode,
  sortAgentIds,
  takesStartMode,
} from './agents'

describe('agent ids', () => {
  it("takes a harness's own id for its default agent, so earlier sessions keep theirs", () => {
    expect(isAgentId('claude-code')).toBe(true)
    expect(isAgentId('opencode')).toBe(true)
    expect(isDefaultAgent('codex')).toBe(true)
    expect(harnessOf('codex')).toBe('codex')
  })

  it('takes <harness>~<slug> for an added agent, only of a harness that carries agents', () => {
    expect(isAgentId('claude-code~work')).toBe(true)
    expect(isAgentId('codex~client-2')).toBe(true)
    expect(isDefaultAgent('codex~client-2')).toBe(false)
    expect(harnessOf('claude-code~work')).toBe('claude-code')
    for (const id of ['opencode~work', 'unknown~work', 'codex~', 'codex~Work', 'codex~-a', 7]) {
      expect(isAgentId(id), String(id)).toBe(false)
    }
    expect(isAgentId(`codex~${'a'.repeat(40)}`)).toBe(true)
    expect(isAgentId(`codex~${'a'.repeat(41)}`)).toBe(false)
  })

  it('knows the harnesses apart from the agents', () => {
    expect(isHarnessId('codex')).toBe(true)
    expect(isHarnessId('codex~work')).toBe(false)
    expect(isHarnessId(null)).toBe(false)
  })

  it('makes an id from the name, unique among those taken', () => {
    expect(addedAgentId('claude-code', 'Work account', [])).toBe('claude-code~work-account')
    expect(addedAgentId('codex', 'Café', [])).toBe('codex~cafe')
    expect(addedAgentId('codex', '工作', [])).toBe('codex~agent')
    expect(addedAgentId('codex', 'Work', ['codex~work', 'codex~work-2'])).toBe('codex~work-3')
    // The same name on another harness is another agent.
    expect(addedAgentId('claude-code', 'Work', ['codex~work'])).toBe('claude-code~work')
    const long = addedAgentId('codex', 'x'.repeat(80), [])
    expect(isAgentId(long)).toBe(true)
  })

  it("sorts agents by their harness's place, each default agent first", () => {
    expect(
      sortAgentIds(['codex~b', 'opencode', 'codex', 'claude-code~work', 'codex~a', 'claude-code']),
    ).toEqual(['claude-code', 'claude-code~work', 'codex', 'codex~a', 'codex~b', 'opencode'])
    expect(sortAgentIds(['codex', 'codex'])).toEqual(['codex'])
  })
})

describe('start modes', () => {
  it('belong to the Claude Code and Codex agents, added ones included', () => {
    for (const id of ['claude-code', 'claude-code~work', 'codex', 'codex~client'] as const) {
      expect(takesStartMode(id), id).toBe(true)
    }
    for (const id of ['opencode', 'pi', 'fake-agent'] as const) {
      expect(takesStartMode(id), id).toBe(false)
    }
  })

  it('take any mode id but one that gives full access', () => {
    expect(isStartMode('claude-code', 'acceptEdits')).toBe(true)
    expect(isStartMode('codex~client', 'agent')).toBe(true)
    for (const mode of ['bypassPermissions', 'agent-full-access', 'danger-full-access']) {
      expect(isFullAccessMode(mode), mode).toBe(true)
      expect(isStartMode('claude-code', mode), mode).toBe(false)
    }
    expect(isFullAccessMode('acceptEdits')).toBe(false)
    expect(isFullAccessMode(undefined)).toBe(false)
  })

  it('are strings of 1 to 64 characters, for an agent that takes one', () => {
    expect(isStartMode('claude-code', 'a'.repeat(64))).toBe(true)
    for (const value of ['', 'a'.repeat(65), 7, null, undefined, ['plan']]) {
      expect(isStartMode('claude-code', value), String(value)).toBe(false)
    }
    expect(isStartMode('opencode', 'plan')).toBe(false)
  })
})
