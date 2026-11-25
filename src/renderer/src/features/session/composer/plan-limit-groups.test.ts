import { describe, expect, it } from 'vitest'
import type { PlanLimit } from '@shared/agent-host'
import { groupPlanLimits } from './plan-limit-groups'

const NOW = Date.UTC(2026, 10, 24, 19, 36)

function limit(
  window: string,
  label: string,
  usedPercent: number | null,
  extra: Partial<PlanLimit> = {},
): PlanLimit {
  return {
    window,
    label,
    usedPercent,
    resetsAt: NOW + 60_000,
    state: 'ok',
    observedAt: NOW,
    ...extra,
  }
}

describe('groupPlanLimits', () => {
  it('将 Antigravity 多模型组按组聚合、组内按 5-hour → Weekly 排序，并将当前模型组置顶', () => {
    const geminiWeekly = limit('seven_day_gemini_models', 'Weekly · Gemini Models', 1, {
      models: ['Gemini 4 Neon', 'Gemini 3.8 Flash'],
    })
    const gemini5h = limit('five_hour_gemini_models', '5-hour · Gemini Models', 1, {
      models: ['Gemini 4 Neon', 'Gemini 3.8 Flash'],
    })
    const thirdPartyWeekly = limit(
      'seven_day_claude_and_gpt_models',
      'Weekly · Claude and GPT models',
      0,
      { models: ['Claude Sonnet 4.6', 'Claude Opus 4.6', 'GPT-OSS 120B'] },
    )
    const thirdParty5h = limit(
      'five_hour_claude_and_gpt_models',
      '5-hour · Claude and GPT models',
      0,
      { models: ['Claude Sonnet 4.6', 'Claude Opus 4.6', 'GPT-OSS 120B'] },
    )
    const all = [geminiWeekly, gemini5h, thirdPartyWeekly, thirdParty5h]

    // 当前使用 Claude/GPT 模型时，Claude and GPT models 组自动置顶并标记为 current
    const claudeGroups = groupPlanLimits(all, [thirdPartyWeekly, thirdParty5h])
    expect(claudeGroups).toHaveLength(2)
    expect(claudeGroups[0]).toMatchObject({
      kind: 'group',
      title: 'Claude and GPT models',
      current: true,
      models: ['Claude Sonnet 4.6', 'Claude Opus 4.6', 'GPT-OSS 120B'],
    })
    expect(claudeGroups[0]!.items.map((item) => [item.limit.window, item.labelMode])).toEqual([
      ['five_hour_claude_and_gpt_models', 'window'],
      ['seven_day_claude_and_gpt_models', 'window'],
    ])
    expect(claudeGroups[1]).toMatchObject({
      kind: 'group',
      title: 'Gemini Models',
      current: false,
      models: ['Gemini 4 Neon', 'Gemini 3.8 Flash'],
    })
    expect(claudeGroups[1]!.items.map((item) => item.limit.window)).toEqual([
      'five_hour_gemini_models',
      'seven_day_gemini_models',
    ])

    // 所有组都命中（未知模型回退）时不误标 current
    const allHeld = groupPlanLimits(all, all)
    expect(allHeld.every((g) => !g.current)).toBe(true)
  })

  it('将 Codex 经典双窗口归为无标题的 solo 组，短窗在前长窗在后', () => {
    const groups = groupPlanLimits([
      limit('seven_day', 'Weekly', 12),
      limit('five_hour', '5-hour', 24),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ kind: 'solo', title: null, current: false })
    expect(groups[0]!.items.map((item) => [item.limit.window, item.labelMode])).toEqual([
      ['five_hour', 'window'],
      ['seven_day', 'window'],
    ])
  })

  it('将 Claude Code 主池与单模型周限拆分为通用组与单模型组', () => {
    const five = limit('five_hour', '5-hour', 42)
    const week = limit('seven_day', 'Weekly', 28)
    const opus = limit('seven_day_opus', 'Weekly · Opus', 64)
    const sonnet = limit('seven_day_sonnet', 'Weekly · Sonnet', 18)

    const groups = groupPlanLimits([five, week, opus, sonnet], [five, week, opus])
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ kind: 'all', title: null, current: true })
    expect(groups[0]!.items.map((item) => item.limit.window)).toEqual(['five_hour', 'seven_day'])
    expect(groups[1]).toMatchObject({
      kind: 'scoped',
      title: null,
      windowKind: 'seven_day',
      current: false,
    })
    expect(groups[1]!.items.map((item) => [item.limit.window, item.labelMode])).toEqual([
      ['seven_day_opus', 'scope'],
      ['seven_day_sonnet', 'scope'],
    ])
  })

  it('将 Codex 主池与附加模型池按池分开展示', () => {
    const groups = groupPlanLimits([
      limit('five_hour', '5-hour', 10),
      limit('seven_day', 'Weekly', 20),
      limit('gpt_5_3_codex_spark_five_hour', '5-hour · GPT-5.3-Codex-Spark', 5),
      limit('gpt_5_3_codex_spark_seven_day', 'Weekly · GPT-5.3-Codex-Spark', 15),
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ kind: 'all', title: null })
    expect(groups[1]).toMatchObject({ kind: 'group', title: 'GPT-5.3-Codex-Spark' })
    expect(groups[1]!.items.map((item) => [item.limit.window, item.labelMode])).toEqual([
      ['gpt_5_3_codex_spark_five_hour', 'window'],
      ['gpt_5_3_codex_spark_seven_day', 'window'],
    ])
  })

  it('按服务商聚合 OpenCode 的多 Provider 配额并去掉重复的服务商前缀', () => {
    const groups = groupPlanLimits([
      limit('anthropic:seven_day', 'Anthropic · Weekly', 30),
      limit('anthropic:five_hour', 'Anthropic · 5-hour', 50),
      limit('openai:five_hour', 'OpenAI · 5-hour', 10),
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ kind: 'group', title: 'Anthropic' })
    expect(groups[0]!.items.map((item) => [item.limit.window, item.labelMode])).toEqual([
      ['anthropic:five_hour', 'window'],
      ['anthropic:seven_day', 'window'],
    ])
    expect(groups[1]).toMatchObject({ kind: 'group', title: 'OpenAI' })
  })

  it('空列表返回空数组，未知窗口名保留完整标签', () => {
    expect(groupPlanLimits([])).toEqual([])
    const groups = groupPlanLimits([limit('custom_bucket', 'Vendor Quota', 40)])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.kind).toBe('solo')
    expect(groups[0]!.items[0]!.labelMode).toBe('full')
  })
})
