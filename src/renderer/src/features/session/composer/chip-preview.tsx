import { useEffect, useState } from 'react'
import { File01Icon, Folder01Icon, GlobalIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { FileContent } from '@shared/files'
import { bytes, fileUrlPath, relativePath } from '@renderer/lib/format'
import { host } from '@renderer/lib/host'
import { hostPlatform, isMac } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import type { DraftAttachment } from '@renderer/stores/attachments'
import { useSettingsStore } from '@renderer/stores/settings'
import { defaultDestination } from '../link-open'
import type { Chip } from './chips'
import { Glyph } from '@renderer/features/shell/glyph'

// Lines a file preview shows: the range with one before it, or the file's first lines.
const PREVIEW_LINES = 6

/** What a chip sends, on hover: a file's lines, an image, a folder's path, a link's address. */
export function ChipPreview({
  chip,
  item,
  projectPath,
  inSession,
}: {
  chip: Chip
  item: DraftAttachment | undefined
  projectPath: string | null
  /** A session's composer, whose links may open in its page in Kettu's browser. */
  inSession: boolean
}) {
  const { t } = useTranslation('composer')
  const thread = useSettingsStore((s) => s.settings.thread)
  if (chip.kind === 'command') return null
  if (chip.kind === 'link') {
    return (
      <div className="flex w-75 flex-col gap-2 p-3">
        <div className="flex min-w-0 items-center gap-1.75 text-small text-tertiary">
          <Glyph icon={GlobalIcon} className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            <b className="font-semibold text-primary">{chip.host}</b>
            {chip.path}
          </span>
        </div>
        <div className="text-hint break-all text-secondary">{chip.url}</div>
        <div className="flex gap-3 text-caption text-tertiary">
          <span>
            {defaultDestination(chip.url, thread, { session: inSession }) === 'session'
              ? t('chips.opensInSession')
              : t('chips.opensInBrowser')}
          </span>
          <span>{t('chips.sentAsLink')}</span>
        </div>
      </div>
    )
  }
  if (chip.kind === 'image') {
    return (
      <div className="flex w-70 flex-col gap-2 p-2">
        {item?.thumb ? (
          <img
            src={item.thumb}
            alt=""
            className="h-37.5 w-full rounded-lg object-cover shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)]"
          />
        ) : (
          <div className="h-37.5 rounded-lg bg-subtle" />
        )}
        <div className="flex gap-2 text-small text-secondary">
          <span className="min-w-0 flex-1 truncate">{chip.label}</span>
          <span className="shrink-0 text-tertiary tabular">
            {[
              item?.pixels && `${item.pixels.width} × ${item.pixels.height}`,
              item?.size != null && bytes(item.size),
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
      </div>
    )
  }
  const path =
    chip.path ??
    (item?.attachment?.uri && projectPath
      ? relativePath(fileUrlPath(item.attachment.uri, hostPlatform()) ?? '', projectPath).replace(
          /\\/g,
          '/',
        )
      : chip.label)
  if (chip.kind === 'folder' || chip.missing) {
    const icon = chip.kind === 'folder' ? Folder01Icon : File01Icon
    return (
      <div className="flex w-75 flex-col gap-1.5 p-2.5">
        <div className="flex items-center gap-2">
          <Glyph icon={icon} className="size-3.5 shrink-0 text-tertiary" />
          <span className="min-w-0 flex-1 truncate font-mono text-caption text-secondary">
            {path}
          </span>
        </div>
        <div className="text-caption text-tertiary">
          {chip.missing ? (item?.error ?? t('chips.missing')) : t('chips.folderSent')}
        </div>
      </div>
    )
  }
  return <FilePreview path={path} lines={chip.lines} projectPath={projectPath} />
}

/** A file's lines as the agent gets them: the range, with the line before it, or its first lines. */
function FilePreview({
  path,
  lines,
  projectPath,
}: {
  path: string
  lines: string | null
  projectPath: string | null
}) {
  const { t } = useTranslation('composer')
  const [content, setContent] = useState<{ path: string; value: FileContent | null } | null>(null)
  useEffect(() => {
    if (!projectPath || path.startsWith('/')) return
    let current = true
    host('files.read', { projectPath, path }).then(
      (value) => current && setContent({ path, value }),
      () => current && setContent({ path, value: null }),
    )
    return () => {
      current = false
    }
  }, [projectPath, path])
  const read = content?.path === path ? content.value : null
  const [start, end] = lines ? lines.split('–').map(Number) : [null, null]
  const first = start ? Math.max(1, start - 1) : 1
  const text = read?.kind === 'text' ? read.text.split('\n') : null
  const shown = text?.slice(first - 1, first - 1 + (end ? end - first + 1 : PREVIEW_LINES)) ?? []
  return (
    <div className="flex w-85 flex-col p-2.5">
      <div className="mb-2 flex items-center gap-2">
        <Glyph icon={File01Icon} className="size-3.5 shrink-0 text-tertiary" />
        <span className="min-w-0 flex-1 truncate font-mono text-caption text-secondary">
          {path}
        </span>
        {lines && (
          <span className="shrink-0 text-caption text-tertiary">{t('chips.lines', { lines })}</span>
        )}
      </div>
      {shown.length > 0 && (
        <div className="overflow-hidden rounded-[5px] bg-code-block py-2 font-mono text-caption leading-[1.7]">
          {shown.map((line, i) => {
            const n = first + i
            const marked = start !== null && n >= start && n <= (end || start)
            return (
              <div key={n} className={cn('flex gap-2.5 px-3', marked && 'bg-control-on-tint')}>
                <span className="w-4 shrink-0 text-right text-tertiary tabular">{n}</span>
                <span className="min-w-0 truncate whitespace-pre text-primary">{line || ' '}</span>
              </div>
            )
          })}
        </div>
      )}
      <div className="mt-2 flex gap-3 text-caption text-tertiary">
        <span>{t('chips.clickToOpen')}</span>
        <span>{t('chips.backspaceRemoves', { key: isMac ? '⌫' : 'Backspace' })}</span>
      </div>
    </div>
  )
}
