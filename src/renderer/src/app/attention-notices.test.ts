import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttentionNotice } from '@shared/attention'
import { i18n } from '@renderer/lib/i18n'

type EventToastCall = {
  content: { title: string; description?: string; warning?: boolean }
  action: { label: string; onClick: () => void }
  options: { id?: string | number; onClose?: () => void }
  returnedId: string
}

const mockState = {
  calls: [] as EventToastCall[],
  nextId: 1,
  shownSessions: [] as string[],
  sessionsById: {} as Record<string, { id: string; projectPath: string; title: string }>,
  openedSessions: [] as Array<{ id: string; projectPath: string }>,
}

vi.mock('@renderer/components/ui/toast', () => ({
  eventToast: (
    content: { title: string; description?: string; warning?: boolean },
    action: { label: string; onClick: () => void },
    options: { id?: string | number; onClose?: () => void } = {},
  ) => {
    const returnedId = options.id !== undefined ? String(options.id) : `toast-${mockState.nextId++}`
    mockState.calls.push({ content, action, options, returnedId })
    return returnedId
  },
}))

vi.mock('@renderer/stores/sessions', () => ({
  useSessionsStore: {
    getState: () => ({ byId: mockState.sessionsById }),
  },
  sessionTitle: (summary: { title: string }) => summary.title,
}))

vi.mock('@renderer/stores/view', () => ({
  useViewStore: {
    getState: () => ({}),
  },
  shownLayoutSessions: () => mockState.shownSessions,
  openSession: (id: string, projectPath: string) => {
    mockState.openedSessions.push({ id, projectPath })
  },
}))

import {
  MAX_MERGED_TITLES,
  MAX_MERGED_TITLE_WIDTH,
  buildAttentionToastContent,
  clipMergedTitle,
  formatMergedNoticeList,
  noticeOf,
} from './attention-notices'

function makeNotice(index: number, overrides: Partial<AttentionNotice> = {}): AttentionNotice {
  return {
    sessionId: `session-${index}`,
    kind: 'turn-ended',
    title: `Session ${index}`,
    body: `Finished step ${index}`,
    ...overrides,
  }
}

function dismissActiveToast(): void {
  const last = mockState.calls.at(-1)
  last?.options.onClose?.()
}

describe('attention-notices merging and folding', () => {
  beforeEach(async () => {
    mockState.calls = []
    mockState.nextId = 1
    mockState.shownSessions = []
    mockState.sessionsById = {}
    mockState.openedSessions = []
    await i18n.changeLanguage('en')
  })

  afterEach(async () => {
    dismissActiveToast()
    await i18n.changeLanguage('en')
  })

  it('merges 1, 2, 3, 4, 5, and 10 notices in English with a 3-item cap', () => {
    const one = buildAttentionToastContent([makeNotice(1)], (n) => n.title, 'en')
    expect(one).toEqual({
      title: 'Session 1',
      description: 'Finished step 1',
      warning: false,
    })

    const two = buildAttentionToastContent([makeNotice(1), makeNotice(2)], (n) => n.title, 'en')
    expect(two).toEqual({
      title: '2 sessions finished',
      description: 'Session 2 and Session 1',
      warning: false,
    })

    const three = buildAttentionToastContent(
      [makeNotice(1), makeNotice(2), makeNotice(3)],
      (n) => n.title,
      'en',
    )
    expect(three).toEqual({
      title: '3 sessions finished',
      description: 'Session 3, Session 2, and Session 1',
      warning: false,
    })

    const four = buildAttentionToastContent(
      Array.from({ length: 4 }, (_, i) => makeNotice(i + 1)),
      (n) => n.title,
      'en',
    )
    expect(four).toEqual({
      title: '4 sessions finished',
      description: 'Session 4, Session 3, Session 2, and 1 more',
      warning: false,
    })

    const five = buildAttentionToastContent(
      Array.from({ length: 5 }, (_, i) => makeNotice(i + 1)),
      (n) => n.title,
      'en',
    )
    expect(five).toEqual({
      title: '5 sessions finished',
      description: 'Session 5, Session 4, Session 3, and 2 more',
      warning: false,
    })

    const ten = buildAttentionToastContent(
      Array.from({ length: 10 }, (_, i) => makeNotice(i + 1)),
      (n) => n.title,
      'en',
    )
    expect(ten).toEqual({
      title: '10 sessions finished',
      description: 'Session 10, Session 9, Session 8, and 7 more',
      warning: false,
    })
  })

  it('merges 1, 2, 3, 4, 5, and 10 notices in zh-CN with localized overflow copy', () => {
    const zhNotice = (i: number) => makeNotice(i, { title: `会话 ${i}`, body: `已完成第 ${i} 步` })

    expect(buildAttentionToastContent([zhNotice(1)], (n) => n.title, 'zh-CN')).toEqual({
      title: '会话 1',
      description: '已完成第 1 步',
      warning: false,
    })

    expect(buildAttentionToastContent([zhNotice(1), zhNotice(2)], (n) => n.title, 'zh-CN')).toEqual(
      {
        title: '2 个会话已结束',
        description: '会话 2和会话 1',
        warning: false,
      },
    )

    expect(
      buildAttentionToastContent([zhNotice(1), zhNotice(2), zhNotice(3)], (n) => n.title, 'zh-CN'),
    ).toEqual({
      title: '3 个会话已结束',
      description: '会话 3、会话 2和会话 1',
      warning: false,
    })

    expect(
      buildAttentionToastContent(
        Array.from({ length: 4 }, (_, i) => zhNotice(i + 1)),
        (n) => n.title,
        'zh-CN',
      ),
    ).toEqual({
      title: '4 个会话已结束',
      description: '会话 4、会话 3、会话 2 等另外 1 个会话',
      warning: false,
    })

    expect(
      buildAttentionToastContent(
        Array.from({ length: 5 }, (_, i) => zhNotice(i + 1)),
        (n) => n.title,
        'zh-CN',
      ),
    ).toEqual({
      title: '5 个会话已结束',
      description: '会话 5、会话 4、会话 3 等另外 2 个会话',
      warning: false,
    })

    expect(
      buildAttentionToastContent(
        Array.from({ length: 10 }, (_, i) => zhNotice(i + 1)),
        (n) => n.title,
        'zh-CN',
      ),
    ).toEqual({
      title: '10 个会话已结束',
      description: '会话 10、会话 9、会话 8 等另外 7 个会话',
      warning: false,
    })
  })

  it('uses waiting copy and warning state when merged notices include errors or permissions', () => {
    const notices = [
      makeNotice(1, { kind: 'turn-ended' }),
      makeNotice(2, { kind: 'permission' }),
      makeNotice(3, { kind: 'error' }),
      makeNotice(4, { kind: 'routine-ended' }),
    ]

    expect(buildAttentionToastContent(notices, (n) => n.title, 'en')).toEqual({
      title: '4 sessions need a look',
      description: 'Session 4, Session 3, Session 2, and 1 more',
      warning: true,
    })

    expect(buildAttentionToastContent(notices, (n) => n.title, 'zh-CN')).toEqual({
      title: '4 个会话需要你看一下',
      description: 'Session 4、Session 3、Session 2 等另外 1 个会话',
      warning: true,
    })
  })

  it('clips overly long English and CJK titles so the overflow count remains compact', () => {
    const longEnglish =
      'Investigate intermittent websocket reconnection timeout across remote relay nodes'
    const clippedEnglish = clipMergedTitle(longEnglish)
    expect(clippedEnglish.endsWith('…')).toBe(true)
    expect(clippedEnglish.length).toBeLessThanOrEqual(MAX_MERGED_TITLE_WIDTH)

    const longChinese = '修复底部通知弹窗在连续合并多条长标题会话消息时撑成超长卡片的问题'
    const clippedChinese = clipMergedTitle(longChinese)
    expect(clippedChinese.endsWith('…')).toBe(true)
    expect(Array.from(clippedChinese).length).toBeLessThanOrEqual(
      Math.ceil(MAX_MERGED_TITLE_WIDTH / 2) + 1,
    )

    expect(clipMergedTitle('  Line one\n\tLine   two  ')).toBe('Line one Line two')

    const formatted = formatMergedNoticeList(
      [longEnglish, longChinese, 'Short task', 'Fourth task', 'Fifth task'],
      'en',
    )
    expect(formatted).toContain(clippedEnglish)
    expect(formatted).toContain(clippedChinese)
    expect(formatted).toContain('Short task')
    expect(formatted).toContain('and 2 more')
    expect(formatted).not.toContain('Fourth task')
    expect(formatted).not.toContain('Fifth task')
  })

  it('reuses one toast across rapid notices, deduplicates by session, and opens the latest', async () => {
    for (let i = 1; i <= 5; i++) {
      mockState.sessionsById[`session-${i}`] = {
        id: `session-${i}`,
        projectPath: `/repo/${i}`,
        title: `Task ${i}`,
      }
      noticeOf(makeNotice(i))
    }

    expect(mockState.calls).toHaveLength(5)
    expect(mockState.calls[0]!.options.id).toBeUndefined()
    expect(mockState.calls[4]!.options.id).toBe('toast-1')
    expect(mockState.calls[4]!.content).toEqual({
      title: '5 sessions finished',
      description: 'Task 5, Task 4, Task 3, and 2 more',
      warning: false,
    })

    // Re-notifying an earlier session deduplicates and promotes it to the front.
    noticeOf(makeNotice(1, { kind: 'error' }))
    expect(mockState.calls[5]!.content).toEqual({
      title: '5 sessions need a look',
      description: 'Task 1, Task 5, Task 4, and 2 more',
      warning: true,
    })

    // Action opens the latest session (session-1 after promotion).
    mockState.calls[5]!.action.onClick()
    expect(mockState.openedSessions).toEqual([{ id: 'session-1', projectPath: '/repo/1' }])

    // Closing the active toast resets the merged map for subsequent notices.
    dismissActiveToast()
    await i18n.changeLanguage('zh-CN')
    noticeOf(makeNotice(6, { title: '新会话', body: '全部完成' }))
    expect(mockState.calls[6]!.options.id).toBeUndefined()
    expect(mockState.calls[6]!.content).toEqual({
      title: '新会话',
      description: '全部完成',
      warning: false,
    })
    expect(mockState.calls[6]!.action.label).toBe('打开')
  })

  it('ignores notices for sessions already visible in the layout', () => {
    mockState.shownSessions = ['session-1']
    noticeOf(makeNotice(1))
    expect(mockState.calls).toHaveLength(0)
    expect(MAX_MERGED_TITLES).toBe(3)
  })
})
