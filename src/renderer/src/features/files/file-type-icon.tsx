import { useSyncExternalStore } from 'react'
import { FileIcon, FolderIcon, FolderOpenIcon } from 'lucide-react'
import { useDark } from '@renderer/hooks/use-dark'
import { cn } from '@renderer/lib/utils'
import { iconId } from './file-icons'

type Theme = typeof import('./file-icon-theme')

let theme: Theme | null = null
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  loading ??= import('./file-icon-theme').then(
    (loaded) => {
      theme = loaded
      for (const notify of listeners) notify()
    },
    () => {
      loading = null
    },
  )
  return () => listeners.delete(listener)
}

/**
 * A file's or folder's icon by its type, in the theme's own colors. A plain line icon stands in
 * while the theme loads.
 */
export function FileTypeIcon({
  path,
  folder = false,
  open = false,
  className,
}: {
  path: string
  folder?: boolean
  open?: boolean
  className?: string
}) {
  const loaded = useSyncExternalStore(subscribe, () => theme)
  const dark = useDark()
  const url = loaded?.iconUrl(
    iconId(loaded.manifest, path, folder ? 'folder' : 'file', { open, light: !dark }),
  )
  if (!url) {
    const Fallback = folder ? (open ? FolderOpenIcon : FolderIcon) : FileIcon
    return <Fallback aria-hidden className={cn('shrink-0 text-muted-foreground', className)} />
  }
  return (
    <img
      src={url}
      alt=""
      aria-hidden
      draggable={false}
      className={cn('shrink-0 select-none', className)}
    />
  )
}
