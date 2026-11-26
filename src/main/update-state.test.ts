import { describe, expect, it } from 'vitest'
import type { UpdateState } from '@shared/updates'
import {
  nextState,
  releaseHighlights,
  type TransitionContext,
  type UpdaterEvent,
} from './update-state'

const context: TransitionContext = {
  mode: 'install',
  autoDownload: true,
  lastCheckedAt: null,
  lastAvailable: null,
}

const READY: UpdateState = { kind: 'ready', version: '0.1.22' }

function run(state: UpdateState, events: UpdaterEvent[], over: Partial<TransitionContext> = {}) {
  return events.reduce((s, event) => nextState(s, event, { ...context, ...over }), state)
}

describe('a check while an update waits for its restart', () => {
  it('keeps the ready update through a manual or automatic check', () => {
    expect(run(READY, [{ type: 'checking', manual: true }])).toBe(READY)
    expect(run(READY, [{ type: 'checking', manual: false }])).toBe(READY)
  })

  it('keeps the ready update when the check finds it again, an older one or none', () => {
    const found = (version: string): UpdaterEvent[] => [
      { type: 'checking', manual: true },
      { type: 'available', version },
    ]
    expect(run(READY, found('0.1.22'))).toBe(READY)
    expect(run(READY, found('0.1.21'))).toBe(READY)
    expect(run(READY, [{ type: 'not-available', at: 1 }])).toBe(READY)
  })

  it('downloads a newer release in its place, which is ready once downloaded', () => {
    const downloading = run(READY, [
      { type: 'checking', manual: true },
      { type: 'available', version: '0.1.23' },
    ])
    expect(downloading).toEqual({
      kind: 'downloading',
      version: '0.1.23',
      percent: 0,
      manual: false,
      replaces: '0.1.22',
    })
    const started = run(downloading, [
      { type: 'download-started', version: '0.1.23', manual: false, replaces: '0.1.22' },
      { type: 'progress', percent: 40 },
    ])
    expect(started).toMatchObject({ kind: 'downloading', percent: 40, replaces: '0.1.22' })
    expect(run(started, [{ type: 'downloaded', version: '0.1.23' }])).toEqual({
      kind: 'ready',
      version: '0.1.23',
    })
  })

  it('offers a newer release without downloading it when downloads are not automatic', () => {
    const state = run(READY, [{ type: 'available', version: '0.1.23' }], { autoDownload: false })
    expect(state).toEqual({ kind: 'available', version: '0.1.23', mode: 'install' })
  })

  // electron-updater empties its download folder for the newer file, so the ready one is gone.
  it('offers the newer release again when its download fails or is cancelled', () => {
    const downloading = run(READY, [
      { type: 'available', version: '0.1.23' },
      { type: 'download-started', version: '0.1.23', manual: false, replaces: '0.1.22' },
    ])
    const offered = { kind: 'available', version: '0.1.23', mode: 'install' }
    expect(run(downloading, [{ type: 'error', message: 'offline', manual: false }])).toEqual(
      offered,
    )
    expect(run(downloading, [{ type: 'download-cancelled' }])).toEqual(offered)
  })
})

describe('releaseHighlights', () => {
  it('parses bilingual notes with folded Simplified Chinese and ignores Contributors', () => {
    const notes = [
      'A short summary line.',
      '',
      '## What changed',
      '',
      '- **Cards stay in reopened sessions**: details here. (#2654)',
      '- Keep timeline dots above the rail (#2675, thanks @akatsukiro).',
      '- Handle multiple credits on macOS (Apple silicon) (#2676, #2677, thanks @alice, @bob).',
      '',
      '<details>',
      '<summary>简体中文更新说明</summary>',
      '',
      '## 中文',
      '',
      '- **重新打开的会话保留卡片**：详细说明。(#2654)',
      '- 修复时间线圆点层级 (#2675，感谢 @akatsukiro)。',
      '- 支持多位贡献者致谢（macOS）(#2676, #2677, 感谢 @alice、@bob)。',
      '',
      '</details>',
      '',
      '## Contributors',
      '',
      '- @akatsukiro',
      '- @alice',
      '',
      '<a href="https://github.com/akatsukiro" title="@akatsukiro"><img src="https://github.com/akatsukiro.png?size=96" width="36" height="36" alt="@akatsukiro" /></a>',
    ].join('\n')

    expect(releaseHighlights(notes)).toEqual({
      en: [
        'Cards stay in reopened sessions',
        'Keep timeline dots above the rail',
        'Handle multiple credits on macOS (Apple silicon)',
      ],
      'zh-CN': ['重新打开的会话保留卡片', '修复时间线圆点层级', '支持多位贡献者致谢（macOS）'],
    })
  })

  it('strips contributor attributions in HTML release notes and ignores Contributors lists', () => {
    const html = [
      '<h2>What changed</h2>',
      '<ul>',
      '<li>Fix session restore (<a href="https://github.com/KettuAI/Kettu/issues/2675">#2675</a>, thanks <a href="https://github.com/akatsukiro">@akatsukiro</a>).</li>',
      '<li>Polish keyboard focus (thanks <a href="https://github.com/alice">@alice</a> and <a href="https://github.com/bob">@bob</a>).</li>',
      '</ul>',
      '<details>',
      '<summary>简体中文更新说明</summary>',
      '<h2>中文</h2>',
      '<ul>',
      '<li>修复会话恢复（<a href="https://github.com/KettuAI/Kettu/issues/2675">#2675</a>，感谢 <a href="https://github.com/akatsukiro">@akatsukiro</a>）。</li>',
      '</ul>',
      '</details>',
      '<h2>Contributors</h2>',
      '<ul>',
      '<li><a href="https://github.com/akatsukiro">@akatsukiro</a></li>',
      '</ul>',
    ].join('\n')

    expect(releaseHighlights(html)).toEqual({
      en: ['Fix session restore', 'Polish keyboard focus'],
      'zh-CN': ['修复会话恢复'],
    })
  })
})
