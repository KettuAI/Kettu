import { useState } from 'react'
import { LinkSquare02Icon, Share08Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { PublishedArtifact, SharingStatus } from '@shared/sharing'
import { Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { useHostScope } from '@renderer/stores/host-scope'
import { canChange } from '@renderer/stores/sharing'
import { useArtifactShares } from './artifact-host'
import { ArtifactHostScope } from './artifact-host-scope'
import { ShareButton } from './share-popover'
import { useThumbnail, type ThumbnailOf } from './thumbnails'

/**
 * An artifact in a client that cannot frame it, as the hosted web client: its preview, and a way to
 * read the live page where the host publishes: the published page, opened in a tab of the browser.
 */
export function PreviewOnly({
  id,
  title,
  summary,
}: {
  id: string
  title: string
  summary: ThumbnailOf | null
}) {
  const shares = useArtifactShares(id)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 overflow-auto p-6 text-center">
      {summary && <Preview summary={summary} />}
      <div className="flex max-w-sm flex-col items-center gap-1">
        {shares ? (
          <ArtifactHostScope id={id}>
            <Where id={id} title={title} latest={summary?.version ?? null} />
          </ArtifactHostScope>
        ) : (
          <Elsewhere />
        )}
      </div>
    </div>
  )
}

/** Where the live page opens, when the artifact's host does not publish pages. */
function Elsewhere() {
  const { t } = useTranslation('artifacts')
  return (
    <>
      <b className="text-sm font-medium text-primary">{t('viewer.previewOnly.title')}</b>
      <p className="text-xs text-secondary">{t('viewer.previewOnly.body')}</p>
    </>
  )
}

function Where({ id, title, latest }: { id: string; title: string; latest: number | null }) {
  const { t } = useTranslation('artifacts')
  const { sharing } = useHostScope()
  const status = sharing.useSharingStore((s) => s.status)
  const [panel, setPanel] = useState(false)
  const published = status?.published.find((page) => page.id === id) ?? null

  // Until the host has said what it published, or with no version to publish, nothing is offered.
  if (!status || (!published && latest === null)) return <Elsewhere />

  // A page that is not public opens through a one-time address, so no code or sign-in is asked
  // for. The tab opens in the click, since a window opened after the request may be blocked.
  const open = (page: PublishedArtifact, current: SharingStatus): void => {
    if (page.access === 'public' || !canChange(page, current)) {
      window.open(page.url, '_blank', 'noreferrer')
      return
    }
    const tab = window.open('', '_blank')
    if (tab) tab.opener = null
    void sharing.openLink(id).then((result) => {
      const url = 'url' in result ? result.url : page.url
      if (!tab) window.open(url, '_blank', 'noreferrer')
      else if (!tab.closed) tab.location.replace(url)
    })
  }

  return (
    <>
      <b className="text-sm font-medium text-primary">{t('viewer.previewOnly.sharedTitle')}</b>
      <p className="text-xs text-secondary">
        {published ? t('viewer.previewOnly.published') : t('viewer.previewOnly.unpublished')}
      </p>
      {published && latest !== null && published.version < latest && (
        <p className="text-xs text-secondary">
          {t('viewer.previewOnly.older', { published: published.version, latest })}
        </p>
      )}
      <div className="mt-2 flex items-stretch justify-center">
        {published ? (
          <Button
            variant="secondary"
            size="sm"
            icon={<Icon icon={LinkSquare02Icon} size={14} />}
            onClick={() => open(published, status)}
          >
            {t('viewer.previewOnly.open')}
          </Button>
        ) : (
          latest !== null && (
            <>
              <Button
                variant="secondary"
                size="sm"
                icon={<Icon icon={Share08Icon} size={14} />}
                aria-expanded={panel}
                onClick={() => setPanel((shown) => !shown)}
              >
                {t('viewer.previewOnly.publish')}
              </Button>
              <ShareButton
                id={id}
                title={title}
                shown={latest}
                head={latest}
                open={panel}
                onOpenChange={setPanel}
              />
            </>
          )
        )}
      </div>
    </>
  )
}

function Preview({ summary }: { summary: ThumbnailOf }) {
  const thumbnail = useThumbnail(summary, true)
  if (thumbnail.state !== 'ready') return null
  return (
    <img
      src={thumbnail.src}
      alt=""
      className="max-h-[60%] max-w-full rounded-lg object-contain shadow-card"
    />
  )
}
