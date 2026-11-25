import { useEffect, useState } from 'react'
import { mediaKindOfName, type MediaGrant } from '@shared/media'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { host } from '@renderer/lib/host'
import { previewImagePath, type PreviewFile } from './file-refs'

/**
 * An image a Markdown file in the Files pane names, read from the project as the pane reads its
 * files, so only a picture inside the project shows. Anything else stays its alt text. Give it
 * `key={written}`, so a different image starts over.
 */
export function PreviewImage({
  file,
  written,
  alt,
}: {
  file: PreviewFile
  written: string
  alt: string
}) {
  const path = previewImagePath(written, file)
  const image = path !== null && mediaKindOfName(path) === 'image'
  const [grant, setGrant] = useState<MediaGrant | 'asking' | null>(image ? 'asking' : null)

  useEffect(() => {
    if (!image || path === null) return
    let current = true
    host('files.read', { projectPath: file.projectPath, path }).then(
      (content) => {
        if (!current) return
        setGrant(content.kind === 'media' && content.grant.kind === 'image' ? content.grant : null)
      },
      () => current && setGrant(null),
    )
    return () => {
      current = false
    }
  }, [file.projectPath, path, image])

  if (grant === null) {
    return <span title={written}>{alt || written.split(/[\\/]/).pop()}</span>
  }
  if (grant === 'asking') {
    return (
      <span className="inline-block h-24 w-40 align-top">
        {/* Shown only when the host takes a while, so a quick answer never flashes. */}
        <span className="block size-full animate-in fade-in fill-mode-both delay-200 duration-(--duration-fast)">
          <Skeleton render={<span />} className="block size-full rounded-code" />
        </span>
      </span>
    )
  }
  return (
    <img
      src={grant.url}
      alt={alt}
      width={grant.width}
      height={grant.height}
      decoding="async"
      loading="lazy"
      onError={() => setGrant(null)}
      className="inline-block h-auto max-w-full align-top"
    />
  )
}
