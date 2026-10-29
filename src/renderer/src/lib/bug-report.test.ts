import { describe, expect, it } from 'vitest'
import type { AppInfo } from '@shared/ipc'
import { bugReportUrl } from './bug-report'

const info: AppInfo = {
  name: 'Kettu',
  version: '0.0.7',
  system: 'macOS 26.0.1 (arm64)',
  userDataPath: '/Users/me/Library/Application Support/Kettu',
  isPackaged: true,
}

describe('bugReportUrl', () => {
  it('opens the bug form with the version and the system filled in', () => {
    const url = new URL(bugReportUrl(info))
    expect(url.origin + url.pathname).toBe('https://github.com/KettuAI/Kettu/issues/new')
    expect(url.searchParams.get('template')).toBe('bug.yml')
    expect(url.searchParams.get('version')).toBe('0.0.7')
    expect(url.searchParams.get('os')).toBe('macOS 26.0.1 (arm64)')
  })

  it('keeps a system with spaces and parentheses whole', () => {
    const url = new URL(bugReportUrl({ ...info, system: 'Ubuntu 24.04.1 LTS (x64)' }))
    expect(url.searchParams.get('os')).toBe('Ubuntu 24.04.1 LTS (x64)')
  })

  it('opens the form alone until the app information has loaded', () => {
    expect(bugReportUrl(null)).toBe('https://github.com/KettuAI/Kettu/issues/new?template=bug.yml')
  })
})
