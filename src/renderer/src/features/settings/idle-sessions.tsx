// Settings › Agents › Idle sessions: when this host's idle Claude Code sessions let their agent go,
// with the memory state and the rule it gives under Auto, and any Claude Code version whose
// resumes lost the prompt cache.

import { useTranslation } from 'react-i18next'
import { useHostScope } from '@renderer/stores/host-scope'
import { useIdleRelease } from '@renderer/stores/idle-release'
import { FallbackNotice, IdleRelease } from './idle-rows'
import { english, type GroupDef, type RowDef } from './model'

/** The Idle sessions group, under the agent list. */
export function useIdleSessionRows(): RowDef[] {
  const { t } = useTranslation('settings')
  const en = english()
  const { hostId } = useHostScope()
  const state = useIdleRelease(hostId)
  const group: GroupDef = { id: 'idle-sessions', label: t('agents.idle.group') }
  const keywords = t('agents.idle.keywords')
  const fallback: RowDef[] = (state?.fallback ?? []).map((version) => ({
    id: `idle-fallback:${version}`,
    name: t('agents.idle.fallback.title', { version }),
    keywords,
    group,
    layout: 'custom',
    render: () => <FallbackNotice version={version} />,
  }))
  return [
    ...fallback,
    {
      id: 'idle-release',
      name: t('agents.idle.release.name'),
      english: en('agents.idle.release.name'),
      description: t('agents.idle.release.description'),
      keywords,
      group,
      layout: 'block',
      render: (text) => <IdleRelease text={text} state={state ?? null} />,
    },
  ]
}
