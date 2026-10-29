import type { AppInfo } from '@shared/ipc'

const FORM_URL = 'https://github.com/KettuAI/Kettu/issues/new?template=bug.yml'

/** The bug form, with the facts it requires filled in while the app's information has loaded. */
export function bugReportUrl(info: AppInfo | null): string {
  if (!info) return FORM_URL
  const params = new URLSearchParams({
    template: 'bug.yml',
    version: info.version,
    os: info.system,
  })
  return `https://github.com/KettuAI/Kettu/issues/new?${params}`
}
