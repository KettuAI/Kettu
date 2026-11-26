import { describe, expect, it } from 'vitest'
import { mcpCallOf, mcpCallsOf, workflowToolOfTitle } from './mcp-call'

describe('mcpCallOf', () => {
  it("reads Claude Code's names for Kettu's and other servers' tools", () => {
    expect(mcpCallOf('mcp__kettu__change_settings')).toEqual({
      server: 'kettu',
      tool: 'change_settings',
      direct: true,
    })
    expect(mcpCallOf('mcp__github__get_issue')).toEqual({
      server: 'github',
      tool: 'get_issue',
      direct: true,
    })
    expect(mcpCallOf('mcp__claude-in-chrome__tabs_context')).toEqual({
      server: 'claude-in-chrome',
      tool: 'tabs_context',
      direct: true,
    })
  })

  it("reads the hosts' server: tool titles in English and Chinese", () => {
    const call = { server: 'kettu', tool: 'find_settings', direct: true }
    expect(mcpCallOf('kettu: find_settings')).toEqual(call)
    expect(mcpCallOf('kettu：find_settings')).toEqual(call)
    expect(mcpCallOf('  kettu : find_settings ')).toEqual(call)
  })

  it('reads the tools of plugins, whose names may hold digits', () => {
    for (const title of [
      'mcp__kettu__s3__list_files',
      'kettu: s3__list_files',
      'kettu_s3__list_files',
    ]) {
      expect(mcpCallOf(title), title).toEqual({
        server: 'kettu',
        tool: 's3__list_files',
        direct: true,
      })
    }
  })

  it("reads other agents' spellings of Kettu's tools", () => {
    expect(mcpCallOf('kettu_read_memory')).toEqual({
      server: 'kettu',
      tool: 'read_memory',
      direct: true,
    })
    expect(mcpCallOf('kettu/read_memory')?.direct).toBe(true)
    expect(mcpCallOf('kettu.read_memory')).toEqual({
      server: 'kettu',
      tool: 'read_memory',
      direct: false,
    })
  })

  it('names no tool for other titles', () => {
    for (const title of [
      'find_settings',
      'Read src/app.ts',
      'github: get_issue',
      'mcp__kettu__',
      'mcp____tool',
      'mcp__kettu__find settings',
      'Run pnpm test',
      'README.md',
      '',
    ]) {
      expect(mcpCallOf(title), title).toBeNull()
    }
  })
})

describe('mcpCallsOf', () => {
  it("reads a script's list of calls only when every part is one", () => {
    expect(mcpCallsOf('kettu.find_settings, kettu.read_memory')?.map((c) => c.tool)).toEqual([
      'find_settings',
      'read_memory',
    ])
    expect(mcpCallsOf('mcp__kettu__list_sessions')?.map((c) => c.tool)).toEqual(['list_sessions'])
    expect(mcpCallsOf('kettu.find_settings, github.search')).toBeNull()
    expect(mcpCallsOf('Read a.ts, b.ts')).toBeNull()
  })
})

describe('workflowToolOfTitle', () => {
  it('recognizes Kettu workflow card tools across every harness title format', () => {
    for (const title of [
      'mcp__kettu__suggest_workflow',
      'kettu: suggest_workflow',
      'kettu：suggest_workflow',
      'kettu_suggest_workflow',
      'kettu.suggest_workflow',
      'kettu/suggest_workflow',
      'mcp_kettu_suggest_workflow',
      'suggest_workflow',
      'kettu.list_workflows, kettu.suggest_workflow',
    ]) {
      expect(workflowToolOfTitle(title), title).toBe('start')
    }
    expect(workflowToolOfTitle('mcp__kettu__create_workflow')).toBe('create')
    expect(workflowToolOfTitle('kettu: report_step')).toBe('report')
    expect(workflowToolOfTitle('kettu：pick_step_agents')).toBe('pick')
  })

  it('ignores non-workflow tools and identically named tools on other servers', () => {
    for (const title of [
      'mcp__other__suggest_workflow',
      'mcp__other__report_step',
      'mcp__kettu__list_workflows',
      'Read workflow.yaml',
      '',
    ]) {
      expect(workflowToolOfTitle(title), title).toBeNull()
    }
  })
})
