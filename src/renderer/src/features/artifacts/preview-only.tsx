import { useTranslation } from 'react-i18next'
import { useThumbnail, type ThumbnailOf } from './thumbnails'

/**
 * An artifact in a client that cannot frame it, as the hosted web client: its preview, and where
 * its live page opens.
 */
export function PreviewOnly({ summary }: { summary: ThumbnailOf | null }) {
  const { t } = useTranslation('artifacts')
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 overflow-auto p-6 text-center">
      {summary && <Preview summary={summary} />}
      <div className="flex max-w-sm flex-col gap-1">
        <b className="text-sm font-medium text-primary">{t('viewer.previewOnly.title')}</b>
        <p className="text-xs text-secondary">{t('viewer.previewOnly.body')}</p>
      </div>
    </div>
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
