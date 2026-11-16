// Kettu's MCP tools as every agent's model receives them: Gemini refuses a function whose
// parameters hold an array without `items`, which fails every request of a session given it.

import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { BROWSER_TOOLS } from './artifacts/browser-tools'
import { DATA_TOOLS } from './artifacts/runtime/data-tools'
import { TOOLS } from './artifacts/tools'
import { COMPUTER_TOOLS } from './computer/tools'
import { DEVICE_TOOLS } from './devices/tools'
import { MARKET_TOOLS } from './marketplace/publish-tools'
import { MEMORY_TOOLS } from './memory/tools'
import { PLAN_TOOLS } from './plan-tool'
import { REPORT_TOOLS } from './report-tool'
import { SESSION_TOOLS } from './session-tools'
import { TERMINAL_TOOLS } from './terminals/tools'
import { WORKFLOW_TOOLS } from './workflow/tools'

const ALL: Tool[] = [
  ...BROWSER_TOOLS,
  ...DATA_TOOLS,
  ...TOOLS,
  ...COMPUTER_TOOLS,
  ...DEVICE_TOOLS,
  ...MARKET_TOOLS,
  ...MEMORY_TOOLS,
  ...PLAN_TOOLS,
  ...REPORT_TOOLS,
  ...SESSION_TOOLS,
  ...TERMINAL_TOOLS,
  ...WORKFLOW_TOOLS,
]

/** The paths of the arrays in a schema that name no `items`. */
function untypedArrays(schema: unknown, at: string): string[] {
  if (typeof schema !== 'object' || schema === null) return []
  const node = schema as Record<string, unknown>
  const types = Array.isArray(node.type) ? node.type : [node.type]
  const own = types.includes('array') && node.items === undefined ? [at] : []
  return [
    ...own,
    ...Object.entries(node).flatMap(([key, value]) =>
      Array.isArray(value)
        ? value.flatMap((item, i) => untypedArrays(item, `${at}.${key}[${i}]`))
        : untypedArrays(value, `${at}.${key}`),
    ),
  ]
}

describe("Kettu's tool schemas", () => {
  it('give every array its items', () => {
    const found = ALL.flatMap((tool) => untypedArrays(tool.inputSchema, tool.name))
    expect(found).toEqual([])
  })
})
