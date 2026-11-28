// Cross-checks the shared harness integration capability matrix against real agent-host
// registries, drivers, and catalog definitions so the checklist stays grounded in code truth.

import { describe, expect, it } from 'vitest'
import { HARNESS_IDS, type HarnessId } from '@shared/agents'
import { HARNESS_CAPABILITIES } from '@shared/harness-capabilities'
import { removesHiddenSessions } from './acp/hidden-sessions'
import { ANTIGRAVITY, buildCatalog } from './catalog'
import { CLAUDE_SDK_DRIVER } from './claude/driver'
import { CODEX_DRIVER } from './codex/driver'
import { hasContextReport, limitsReport } from './reports'
import { ROUTINE_HARNESSES } from './routines/tools'
import { sideRoute } from './side-chat'
import { LOG_READERS } from './usage/readers'
import { storedSignInReader } from './vendor-usage/readers'
import { STEP_HARNESSES } from './workflow/picks'

const DIRECT_LIMITS_HARNESSES = new Set<HarnessId>([
  'claude-code',
  'codex',
  'opencode',
  'antigravity',
  'grok',
  'mistral-vibe',
  'copilot',
  'qoder',
  'qoder-cn',
  'kilo',
  'auggie',
])

describe('harness capability matrix vs agent-host registries', () => {
  const catalog = buildCatalog('/fake/path')

  it('covers every harness registered in the agent-host catalog', () => {
    const catalogIds = catalog.map((def) => def.id).sort()
    expect(catalogIds).toEqual([...HARNESS_IDS].sort())
  })

  it('matches planLimits statuses and verified gapReasons with catalog limitsReason and readers', () => {
    for (const def of catalog) {
      const entry = HARNESS_CAPABILITIES[def.id].planLimits

      if (def.id === 'deepseek') {
        expect(entry).toEqual({
          status: 'partial',
          gapReason: 'upstream',
          note: 'deepseekBalanceOnly',
        })
        continue
      }

      if (def.limitsReason === 'not-yet-supported') {
        expect(entry.status).toBe('unavailable')
        expect(entry.gapReason).toBe('kettu')
        continue
      }

      if (def.limitsReason) {
        expect(entry.status).toBe('unavailable')
        expect(entry.gapReason).toBe('upstream')
        continue
      }

      const hasReader =
        DIRECT_LIMITS_HARNESSES.has(def.id) ||
        storedSignInReader(def.id) !== null ||
        limitsReport(def.id) !== null
      expect(hasReader).toBe(true)
      expect(entry.status).toBe('supported')
      expect(entry.gapReason).toBeUndefined()
    }
  })

  it('matches workflowsAndRoutines against STEP_HARNESSES and ROUTINE_HARNESSES', () => {
    const routineSet = new Set<HarnessId>(ROUTINE_HARNESSES)
    for (const harness of HARNESS_IDS) {
      const entry = HARNESS_CAPABILITIES[harness].workflowsAndRoutines
      if (STEP_HARNESSES.has(harness) && routineSet.has(harness)) {
        expect(entry.status).toBe('supported')
        expect(entry.gapReason).toBeUndefined()
      } else if (harness === 'opencode') {
        expect(entry.status).toBe('partial')
        expect(entry.gapReason).toBe('kettu')
      } else {
        expect(entry.status).toBe('unavailable')
      }
    }
  })

  it('marks every Usage page LOG_READERS agent supported for usageHistory', () => {
    const readerAgents = new Set(LOG_READERS.map((reader) => reader.agentId))
    for (const harness of HARNESS_IDS) {
      const entry = HARNESS_CAPABILITIES[harness].usageHistory
      if (readerAgents.has(harness)) {
        expect(entry.status).toBe('supported')
      } else if (harness === 'cline') {
        expect(entry.status).toBe('partial')
        expect(entry.gapReason).toBe('kettu')
      } else {
        expect(entry.status).toBe('unavailable')
      }
    }
  })

  it('matches contextBreakdown against driver reads and catalog context flags', () => {
    expect(CLAUDE_SDK_DRIVER.reads?.context).toBe(true)
    expect(HARNESS_CAPABILITIES['claude-code'].contextBreakdown.status).toBe('supported')

    expect(ANTIGRAVITY.readsContext).toBe(true)
    expect(HARNESS_CAPABILITIES.antigravity.contextBreakdown.status).toBe('supported')

    expect(CODEX_DRIVER.reads?.context).toBeFalsy()
    expect(CODEX_DRIVER.reads?.contextEstimates).toBe(true)
    expect(HARNESS_CAPABILITIES.codex.contextBreakdown).toEqual({
      status: 'partial',
      gapReason: 'upstream',
      note: 'codexEstimatesOnly',
    })

    expect(hasContextReport('fake-agent')).toBe(true)
    expect(HARNESS_CAPABILITIES['fake-agent'].contextBreakdown.status).toBe('supported')

    for (const harness of HARNESS_IDS) {
      if (['claude-code', 'codex', 'antigravity', 'fake-agent'].includes(harness)) continue
      expect(HARNESS_CAPABILITIES[harness].contextBreakdown.status).toBe('unavailable')
    }
  })

  it('matches sideChat against sideRoute and hidden-session removal support', () => {
    for (const harness of HARNESS_IDS) {
      const route = sideRoute(harness)
      const entry = HARNESS_CAPABILITIES[harness].sideChat
      if (route === 'none') {
        expect(entry.status).toBe('unavailable')
      } else if (harness === 'junie') {
        expect(removesHiddenSessions('junie')).toBe(true)
        expect(entry.status).toBe('partial')
      } else {
        expect(entry.status).toBe('supported')
      }
    }

    expect(removesHiddenSessions('antigravity')).toBe(false)
    expect(HARNESS_CAPABILITIES.antigravity.sideChat).toEqual({
      status: 'unavailable',
      gapReason: 'upstream',
      note: 'agyNoSilentDelete',
    })
  })

  it('reflects native rewind and file rewind accurately for dedicated drivers', () => {
    expect(HARNESS_CAPABILITIES['claude-code'].rewind.status).toBe('supported')
    expect(HARNESS_CAPABILITIES.codex.rewind).toEqual({
      status: 'partial',
      gapReason: 'upstream',
      note: 'codexPaginatedThreadsOnly',
    })
    expect(HARNESS_CAPABILITIES.opencode.rewind.status).toBe('supported')
    expect(HARNESS_CAPABILITIES.opencode.fileRewind.status).toBe('supported')
    expect(HARNESS_CAPABILITIES.pi.rewind.status).toBe('supported')
    expect(HARNESS_CAPABILITIES.pi.fileRewind).toEqual({
      status: 'unavailable',
      gapReason: 'upstream',
    })
    expect(HARNESS_CAPABILITIES.cline.rewind).toEqual({
      status: 'partial',
      gapReason: 'upstream',
      note: 'clineSdkOnly',
    })
    expect(HARNESS_CAPABILITIES.deepseek.rewind).toEqual({
      status: 'unavailable',
      gapReason: 'upstream',
    })
  })
})
