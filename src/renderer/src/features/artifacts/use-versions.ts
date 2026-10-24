import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { VersionSummary } from '@shared/artifacts'
import { errorMessage, host } from '@renderer/lib/host'
import { useSessionsStore } from '@renderer/stores/sessions'

/** Every version, newest first, read again whenever the latest changes. */
export function useVersions(
  id: string,
  head: number | null,
): {
  versions: VersionSummary[] | null
  error: string | null
} {
  const [read, setRead] = useState<{ versions: VersionSummary[] | null; error: string | null }>({
    versions: null,
    error: null,
  })
  useEffect(() => {
    let live = true
    host('artifacts.versions', { id }).then(
      (versions) => live && setRead({ versions, error: null }),
      (error: unknown) => live && setRead((r) => ({ ...r, error: errorMessage(error) })),
    )
    return () => {
      live = false
    }
  }, [id, head])
  return read
}

/** Who wrote a version: a session's title, "You", or a session no longer in the index. */
export function useAuthor(): (author: string | null) => string {
  const { t } = useTranslation(['artifacts', 'common'])
  const byId = useSessionsStore((s) => s.byId)
  return (author) => {
    if (author === null) return t('history.you')
    const session = byId[author]
    if (!session) return t('page.deletedSession')
    return session.title ?? t('common:untitledSession')
  }
}
