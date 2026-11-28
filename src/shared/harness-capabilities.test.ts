import { describe, expect, it } from 'vitest'
import { HARNESS_IDS, MULTI_AGENT_HARNESSES, type AgentId } from './agents'
import {
  HARNESS_CAPABILITIES,
  HARNESS_CAPABILITY_IDS,
  harnessCapabilities,
  resolveHarnessCapabilities,
  summarizeHarnessCapabilities,
  type CapabilityGapReason,
  type CapabilitySupport,
} from './harness-capabilities'
import enSettings from './locales/en/settings.json'
import zhSettings from './locales/zh-CN/settings.json'

const VALID_STATUSES = new Set<CapabilitySupport>(['supported', 'partial', 'unavailable'])
const VALID_REASONS = new Set<CapabilityGapReason>(['upstream', 'kettu'])

describe('harness-capabilities', () => {
  it('defines an exhaustive checklist covering every registered built-in harness', () => {
    const definedHarnesses = Object.keys(HARNESS_CAPABILITIES).sort()
    const allHarnesses = [...HARNESS_IDS].sort()
    expect(definedHarnesses).toEqual(allHarnesses)
  })

  it('gives every harness the exact same ordered capability ids and valid entries', () => {
    for (const harness of HARNESS_IDS) {
      const map = HARNESS_CAPABILITIES[harness]
      expect(Object.keys(map)).toEqual([...HARNESS_CAPABILITY_IDS])

      const resolved = resolveHarnessCapabilities(harness)
      expect(resolved.map((item) => item.id)).toEqual([...HARNESS_CAPABILITY_IDS])

      for (const item of resolved) {
        expect(VALID_STATUSES.has(item.status)).toBe(true)
        if (item.gapReason !== undefined) {
          expect(VALID_REASONS.has(item.gapReason)).toBe(true)
          expect(item.status).not.toBe('supported')
        }
      }

      const summary = summarizeHarnessCapabilities(resolved)
      expect(summary.total).toBe(HARNESS_CAPABILITY_IDS.length)
      expect(summary.supported + summary.partial + summary.unavailable).toBe(summary.total)
    }
  })

  it('resolves custom added multi-account agents via their underlying harness', () => {
    for (const harness of MULTI_AGENT_HARNESSES) {
      const added: AgentId = `${harness}~work`
      expect(harnessCapabilities(added)).toBe(HARNESS_CAPABILITIES[harness])
      expect(resolveHarnessCapabilities(added)).toEqual(resolveHarnessCapabilities(harness))
    }
  })

  it('keeps static ACP defaults when the agent has never initialized', () => {
    const uninitialized = resolveHarnessCapabilities('cursor', {
      steering: false,
      forkSession: false,
      forkAtMessage: false,
      mcpHttp: null,
      prompt: null,
    })
    const byId = Object.fromEntries(uninitialized.map((item) => [item.id, item]))
    expect(byId.steering).toEqual({ id: 'steering', status: 'unavailable' })
    expect(byId.fork).toEqual({
      id: 'fork',
      status: 'partial',
      note: 'dependsOnAcpAdapter',
    })
    expect(byId.imageInput).toEqual({
      id: 'imageInput',
      status: 'partial',
      note: 'dependsOnAcpAdapter',
    })
    expect(byId.mcp).toEqual({
      id: 'mcp',
      status: 'partial',
      note: 'acpStdioAlwaysHttpDepends',
    })
  })

  it('refines runtime-negotiated ACP entries once capabilities are observed', () => {
    const supportedRuntime = resolveHarnessCapabilities('cursor', {
      steering: true,
      forkSession: true,
      forkAtMessage: false,
      mcpHttp: true,
      prompt: { image: true },
    })
    const supportedById = Object.fromEntries(supportedRuntime.map((item) => [item.id, item]))
    expect(supportedById.steering).toEqual({ id: 'steering', status: 'supported' })
    expect(supportedById.fork).toEqual({
      id: 'fork',
      status: 'partial',
      gapReason: 'upstream',
      note: 'acpNoForkAtMessage',
    })
    expect(supportedById.imageInput).toEqual({ id: 'imageInput', status: 'supported' })
    expect(supportedById.mcp).toEqual({ id: 'mcp', status: 'supported' })

    const limitedRuntime = resolveHarnessCapabilities('cursor', {
      steering: false,
      forkSession: false,
      forkAtMessage: false,
      mcpHttp: false,
      prompt: { image: false },
    })
    const limitedById = Object.fromEntries(limitedRuntime.map((item) => [item.id, item]))
    expect(limitedById.steering).toEqual({ id: 'steering', status: 'unavailable' })
    expect(limitedById.fork).toEqual({
      id: 'fork',
      status: 'unavailable',
      gapReason: 'upstream',
    })
    expect(limitedById.imageInput).toEqual({
      id: 'imageInput',
      status: 'unavailable',
      gapReason: 'upstream',
    })
    expect(limitedById.mcp).toEqual({
      id: 'mcp',
      status: 'partial',
      gapReason: 'upstream',
      note: 'acpStdioOnlyNoHttp',
    })
  })

  it('has complete en and zh-CN translations for every capability, status, reason, and note', () => {
    const usedNotes = new Set<string>()
    for (const harness of HARNESS_IDS) {
      for (const item of resolveHarnessCapabilities(harness)) {
        if (item.note) usedNotes.add(item.note)
      }
    }
    // Runtime-only ACP refinement notes.
    usedNotes.add('acpNoForkAtMessage')
    usedNotes.add('acpStdioOnlyNoHttp')

    for (const catalog of [enSettings, zhSettings]) {
      const cap = catalog.agents.capabilities
      expect(cap.title.length).toBeGreaterThan(0)
      expect(cap.summary).toContain('{{supported}}')
      expect(cap.summary).toContain('{{partial}}')
      expect(cap.summary).toContain('{{unavailable}}')

      for (const status of VALID_STATUSES) {
        expect(cap.status[status].length).toBeGreaterThan(0)
      }
      for (const reason of VALID_REASONS) {
        expect(cap.reason[reason].length).toBeGreaterThan(0)
      }
      for (const id of HARNESS_CAPABILITY_IDS) {
        expect(cap.items[id].length).toBeGreaterThan(0)
      }
      for (const note of usedNotes) {
        expect(cap.notes[note as keyof typeof cap.notes]?.length ?? 0).toBeGreaterThan(0)
      }
    }
  })
})
