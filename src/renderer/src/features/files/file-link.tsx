import { useContext, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import {
  BrowserIcon,
  File01Icon,
  FolderOpenIcon,
  Link01Icon,
  LinkSquare02Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { SessionIdContext } from '@renderer/features/session/media/grants'
import { BrowserIcon as DefaultBrowserIcon } from '@renderer/features/session/markdown/web-link'
import { useNoHover } from '@renderer/hooks/use-no-hover'
import { fileManagerName, isMod, isWeb } from '@renderer/lib/platform'
import { openFile } from '@renderer/stores/files'
import { loadSiteIcons, useDefaultBrowser } from '@renderer/stores/site-icons'
import type { FilePreviewSource } from './file-hover-cache'
import {
  formatFileTarget,
  formatLineRange,
  normalizeLineRange,
  shouldReadAsText,
} from './file-hover-model'
import { FileHoverPreview } from './file-hover-preview'
import { fileLinkActions, fileLinkClickTarget } from './file-link-actions'
import { FileTypeIcon } from './file-type-icon'
import type { AgentFileRef, FileRef } from './file-refs'
import { isHtmlFile, openHtmlInBrowser, previewHtml, useHtmlPreview } from './html-preview'
import {
  copyFilePathText,
  hostFilePath,
  openFileInDefaultApp,
  showFileInManager,
} from './operations'
import { nameOf } from './paths'

/** An HTML file's page, in a tab of the session's browser or in the default one. */
interface PagePreview {
  inKettu: () => void
  inBrowser: () => void
}

/**
 * The chip both kinds of file reference draw, like the thread's links: the file's icon and name
 * over one line, with an interactive scrollable hover preview on hover-capable desktops. A plain
 * click opens it in Kettu's Files pane, and a Mod-click (Cmd on macOS, Ctrl elsewhere) opens a
 * local file with the system's default app. A right click offers to open with the default app and
 * show the file in the file manager, which only this computer's files can do, and to copy its path.
 * An HTML file's page can be previewed too: from a small button over the text after the chip while
 * it is hovered or focused, so the line never moves, and from the menu.
 */
function FileChip({
  path,
  line,
  endLine = null,
  projectPath,
  hostFile,
  previewSource,
  onOpen,
  page = null,
}: {
  path: string
  line: number | null
  endLine?: number | null
  projectPath: string
  /** The file's path as its host writes it, without any line suffix. */
  hostFile: string
  previewSource: FilePreviewSource
  onOpen: () => void
  page?: PagePreview | null
}) {
  const { t } = useTranslation('files')
  const noHover = useNoHover()
  const [menuOpen, setMenuOpen] = useState(false)
  const [hoverOpen, setHoverOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // A wrapped inline reference has a box per line; anchor the preview to the first line.
  const firstLine = useMemo(
    () => ({
      getBoundingClientRect: () =>
        triggerRef.current?.getClientRects()[0] ??
        triggerRef.current?.getBoundingClientRect() ??
        new DOMRect(),
      get contextElement() {
        return triggerRef.current ?? undefined
      },
    }),
    [],
  )
  const range = normalizeLineRange(line, endLine)
  const lineLabel = formatLineRange(range)
  const target = formatFileTarget(path, range)
  const { localFile } = fileLinkActions({ projectPath, hostFile, web: isWeb })
  const handleMenuOpenChange = (next: boolean) => {
    setMenuOpen(next)
    if (next) setHoverOpen(false)
  }
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    setHoverOpen(false)
    if (fileLinkClickTarget({ localFile, mod: isMod(event) }) === 'default-app') {
      event.preventDefault()
      openFileInDefaultApp(localFile!)
      return
    }
    onOpen()
  }
  const trigger = (
    <ContextMenuTrigger
      className="select-auto"
      render={
        <button
          ref={triggerRef}
          type="button"
          data-file-ref=""
          title={noHover ? target : undefined}
          aria-label={t('link.open', { target })}
          onClick={handleClick}
        />
      }
    />
  )
  const label = (
    /* A button lays out as an inline block, so the line is drawn by an inline span inside it,
       at the same depth as a link's. */
    <span className="thread-link">
      <FileTypeIcon
        path={path}
        className="relative -top-[1.5px] mr-1.5 inline-block size-4 align-middle"
      />
      {nameOf(path)}
      {lineLabel && <span className="text-tertiary">:{lineLabel}</span>}
    </span>
  )
  const chip = (
    <ContextMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
      <FileHoverPreview
        source={previewSource}
        path={path}
        range={range}
        onOpen={onOpen}
        open={hoverOpen}
        onOpenChange={setHoverOpen}
        suppressed={menuOpen}
        anchor={firstLine}
        trigger={trigger}
      >
        {label}
      </FileHoverPreview>
      <ContextMenuContent className="min-w-56">
        {page && <PageItems page={page} onOpen={onOpen} />}
        {localFile && (
          <>
            <ContextMenuItem onClick={() => openFileInDefaultApp(localFile)}>
              <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={1.9} aria-hidden />
              {t('preview.openWithDefault')}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => showFileInManager(localFile)}>
              <HugeiconsIcon icon={FolderOpenIcon} strokeWidth={1.9} aria-hidden />
              {t('preview.showIn', { name: fileManagerName() })}
            </ContextMenuItem>
          </>
        )}
        <ContextMenuItem onClick={() => copyFilePathText(hostFile)}>
          <HugeiconsIcon icon={Link01Icon} strokeWidth={1.9} aria-hidden />
          {t('tree.copyPath')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
  if (!page) return chip
  return (
    <span className="ks-ref-page">
      {chip}
      <span className="ks-ref-page__dock">
        <Tooltip>
          <TooltipTrigger
            delay={500}
            render={
              <button
                type="button"
                className="ks-page-btn focus-ring"
                aria-label={t('htmlPreview.inKettu')}
                onClick={page.inKettu}
              />
            }
          >
            <HugeiconsIcon icon={BrowserIcon} size={13} strokeWidth={1.9} aria-hidden />
            {t('htmlPreview.preview')}
          </TooltipTrigger>
          <TooltipContent>{t('htmlPreview.inKettu')}</TooltipContent>
        </Tooltip>
      </span>
    </span>
  )
}

/** The menu's first items for an HTML file: its page in either browser, or its source. */
function PageItems({ page, onOpen }: { page: PagePreview; onOpen: () => void }) {
  const { t } = useTranslation('files')
  const browser = useDefaultBrowser()
  useEffect(loadSiteIcons, [])
  return (
    <>
      <ContextMenuItem onClick={page.inKettu}>
        <HugeiconsIcon icon={BrowserIcon} strokeWidth={1.9} aria-hidden />
        {t('htmlPreview.inKettu')}
      </ContextMenuItem>
      <ContextMenuItem onClick={page.inBrowser}>
        <DefaultBrowserIcon browser={browser} className="size-3.75" />
        {t('htmlPreview.inDefault')}
      </ContextMenuItem>
      <ContextMenuItem onClick={onOpen}>
        <HugeiconsIcon icon={File01Icon} strokeWidth={1.9} aria-hidden />
        {t('htmlPreview.openFile')}
      </ContextMenuItem>
      <ContextMenuSeparator />
    </>
  )
}

/**
 * A file reference in a reply, drawn like the thread's links: the file's icon and name over one
 * line, with a scrollable preview on hover on desktop. It opens the file in the Files pane at its
 * line.
 */
export function FileLink({ file }: { file: FileRef & { projectPath: string } }) {
  const sessionId = useContext(SessionIdContext)
  const previewable = useHtmlPreview(sessionId, file.projectPath) && isHtmlFile(file.path)
  const range = normalizeLineRange(file.line, file.endLine)
  const previewSource = useMemo<FilePreviewSource>(
    () => ({
      kind: 'project',
      projectPath: file.projectPath,
      path: file.path,
      ...(shouldReadAsText(file.path, range) && { asText: true }),
    }),
    [file.projectPath, file.path, range],
  )
  return (
    <FileChip
      path={file.path}
      line={file.line}
      endLine={file.endLine ?? null}
      projectPath={file.projectPath}
      hostFile={hostFilePath(file.projectPath, file.path)}
      previewSource={previewSource}
      onOpen={() => openFile(file.projectPath, file.path, file.line, { preview: true })}
      page={
        previewable && sessionId
          ? {
              inKettu: () => void previewHtml(sessionId, file.path),
              inBrowser: () => void openHtmlInBrowser(sessionId, file.path),
            }
          : null
      }
    />
  )
}

/** A link to a file of the session agent's own folder, drawn the same; it opens read-only. */
export function AgentFileLink({ file }: { file: AgentFileRef }) {
  const previewSource = useMemo<FilePreviewSource>(
    () => ({ kind: 'agent', sessionId: file.sessionId, path: file.path }),
    [file.sessionId, file.path],
  )
  return (
    <FileChip
      path={file.path}
      line={file.line}
      endLine={file.endLine ?? null}
      projectPath={file.projectPath}
      hostFile={file.path}
      previewSource={previewSource}
      onOpen={() =>
        openFile(file.projectPath, file.path, file.line, {
          preview: true,
          agent: { sessionId: file.sessionId, agentId: file.agentId },
        })
      }
    />
  )
}
