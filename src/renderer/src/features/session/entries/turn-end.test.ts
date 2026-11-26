import { afterEach, describe, expect, it } from 'vitest'
import { fullTime, turnDuration } from '@renderer/lib/format'
import { i18n } from '@renderer/lib/i18n'
import { completedTurnDuration, turnEndTagText } from './turn-end'

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('turnDuration', () => {
  it('omits missing, zero, negative, and non-finite durations', () => {
    expect(turnDuration(undefined)).toBeNull()
    expect(turnDuration(null)).toBeNull()
    expect(turnDuration(0)).toBeNull()
    expect(turnDuration(-1500)).toBeNull()
    expect(turnDuration(Number.NaN)).toBeNull()
    expect(turnDuration(Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('formats durations cleanly in English', async () => {
    await i18n.changeLanguage('en')
    expect(turnDuration(1)).toBe('< 1s')
    expect(turnDuration(450)).toBe('< 1s')
    expect(turnDuration(999)).toBe('< 1s')
    expect(turnDuration(1000)).toBe('1s')
    expect(turnDuration(2986)).toBe('3s')
    expect(turnDuration(59_400)).toBe('59s')
    expect(turnDuration(59_600)).toBe('1m')
    expect(turnDuration(60_000)).toBe('1m')
    expect(turnDuration(72_000)).toBe('1m 12s')
    expect(turnDuration(3_599_000)).toBe('59m 59s')
    expect(turnDuration(3_600_000)).toBe('1h')
    expect(turnDuration(3_840_000)).toBe('1h 4m')
  })

  it('formats durations cleanly in Simplified Chinese', async () => {
    await i18n.changeLanguage('zh-CN')
    expect(turnDuration(450)).toBe('< 1 秒')
    expect(turnDuration(3_000)).toBe('3 秒')
    expect(turnDuration(60_000)).toBe('1 分钟')
    expect(turnDuration(72_000)).toBe('1 分 12 秒')
    expect(turnDuration(3_600_000)).toBe('1 小时')
    expect(turnDuration(3_840_000)).toBe('1 小时 4 分')
  })
})

describe('completedTurnDuration', () => {
  const completedAt = Date.UTC(2026, 10, 26, 14, 3, 0)

  it('formats normal completed turns with tooltip in English', async () => {
    await i18n.changeLanguage('en')
    const result = completedTurnDuration(
      { stopReason: 'end_turn', durationMs: 72_000 },
      completedAt,
    )
    expect(result).toEqual({
      label: 'Worked for 1m 12s',
      title: `Worked for 1m 12s · Completed ${fullTime(completedAt)}`,
    })
  })

  it('formats normal completed turns with tooltip in Simplified Chinese', async () => {
    await i18n.changeLanguage('zh-CN')
    const result = completedTurnDuration({ stopReason: 'end_turn', durationMs: 4_090 }, completedAt)
    expect(result).toEqual({
      label: '用时 4 秒',
      title: `用时 4 秒 · 完成于 ${fullTime(completedAt)}`,
    })
  })

  it('falls back to the duration label for title when completion timestamp is absent', async () => {
    await i18n.changeLanguage('en')
    expect(completedTurnDuration({ stopReason: 'end_turn', durationMs: 450 })).toEqual({
      label: 'Worked for < 1s',
      title: 'Worked for < 1s',
    })
  })

  it('returns null when turn_end is missing or duration is zero/invalid', () => {
    expect(completedTurnDuration(undefined, completedAt)).toBeNull()
    expect(completedTurnDuration(null, completedAt)).toBeNull()
    expect(completedTurnDuration({ stopReason: 'end_turn', durationMs: 0 }, completedAt)).toBeNull()
    expect(
      completedTurnDuration({ stopReason: 'end_turn', durationMs: -10 }, completedAt),
    ).toBeNull()
    expect(
      completedTurnDuration({ stopReason: 'end_turn', durationMs: Number.NaN }, completedAt),
    ).toBeNull()
  })

  it('returns null for stopped or abnormal turns handled by TurnEndTag', () => {
    expect(
      completedTurnDuration({ stopReason: 'cancelled', durationMs: 12_000 }, completedAt),
    ).toBeNull()
    expect(
      completedTurnDuration({ stopReason: 'max_tokens', durationMs: 12_000 }, completedAt),
    ).toBeNull()
    expect(
      completedTurnDuration({ stopReason: 'max_turn_requests', durationMs: 12_000 }, completedAt),
    ).toBeNull()
    expect(
      completedTurnDuration({ stopReason: 'refusal', durationMs: 12_000 }, completedAt),
    ).toBeNull()
  })
})

describe('turnEndTagText', () => {
  it('omits invalid or zero duration on normal endings and formats valid ones', async () => {
    await i18n.changeLanguage('en')
    expect(turnEndTagText('end_turn', 0)).toBeNull()
    expect(turnEndTagText('end_turn', undefined)).toBeNull()
    expect(turnEndTagText('end_turn', 500)).toBe('Worked for < 1s')
    expect(turnEndTagText('end_turn', 72_000)).toBe('Worked for 1m 12s')
  })

  it('renders abnormal stop reasons with time only past one second in en and zh-CN', async () => {
    await i18n.changeLanguage('en')
    expect(turnEndTagText('cancelled', 0)).toBe('Cancelled')
    expect(turnEndTagText('cancelled', 850)).toBe('Cancelled')
    expect(turnEndTagText('cancelled', 12_000)).toBe('Cancelled · 12s')
    expect(turnEndTagText('max_tokens', 72_000)).toBe('Stopped at the token limit · 1m 12s')
    expect(turnEndTagText('refusal', 3_000)).toBe('Declined · 3s')

    await i18n.changeLanguage('zh-CN')
    expect(turnEndTagText('cancelled', 500)).toBe('已取消')
    expect(turnEndTagText('cancelled', 12_000)).toBe('已取消 · 12 秒')
    expect(turnEndTagText('max_tokens', 60_000)).toBe('已达到 token 上限而停止 · 1 分钟')
  })
})
