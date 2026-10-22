import 'streamdown/styles.css'
import { memo, useDeferredValue, useState, type ComponentProps } from 'react'
import { cjk } from '@streamdown/cjk'
import { createCodePlugin } from '@streamdown/code'
import { useTranslation } from 'react-i18next'
import {
  defaultComponents,
  Streamdown,
  type Components,
  type ExtraProps,
  type LinkSafetyModalProps,
} from 'streamdown'
import { GITHUB_PULL_REQUEST_URL } from '@shared/git'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { FileLink } from '@renderer/features/files/file-link'
import { useFileRef } from '@renderer/features/files/file-refs'
import { PrChip } from '@renderer/features/git/pr-chip'
import { cn } from '@renderer/lib/utils'
import { splitIntoChunks } from './chunks'

const plugins = {
  code: createCodePlugin({ themes: ['github-light-default', 'github-dark-default'] }),
  cjk,
}

const DefaultLink = defaultComponents.a

/** A link: a pull request chip, a project file, or the default link with its safety check. */
function Link(props: ComponentProps<'a'> & ExtraProps) {
  const href = typeof props.href === 'string' ? props.href : ''
  const file = useFileRef(href)
  if (GITHUB_PULL_REQUEST_URL.test(href)) return <PrChip url={href} />
  if (file) {
    return (
      <FileLink file={file}>
        <span data-streamdown="link">{props.children}</span>
      </FileLink>
    )
  }
  return <DefaultLink {...props} />
}

/** Inline code, which opens the file in the Files pane when it is a path in the project. */
function InlineCode({ className, children }: ComponentProps<'code'> & ExtraProps) {
  const file = useFileRef(typeof children === 'string' ? children : null)
  const code = (
    <code className={className} data-streamdown="inline-code">
      {children}
    </code>
  )
  return file ? <FileLink file={file}>{code}</FileLink> : code
}

const components: Components = { a: Link, inlineCode: InlineCode }

function LinkConfirm({ isOpen, onClose, onConfirm, url }: LinkSafetyModalProps) {
  const { t } = useTranslation(['session', 'common'])
  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('link.title')}</AlertDialogTitle>
          <AlertDialogDescription className="font-mono text-xs break-all" data-selectable="">
            {url}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{t('link.open')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

const linkSafety = {
  enabled: true,
  renderModal: (props: LinkSafetyModalProps) => <LinkConfirm {...props} />,
}

// Module constants: Streamdown's context depends on these, and a new object per render would
// re-render every code block and table on each streamed chunk.
const controls = {
  code: { copy: true, download: false },
  table: { copy: true, download: false, fullscreen: false },
  mermaid: false,
}

/** The text's chunks, kept from the previous render while the text only grows. */
function useChunks(markdown: string): string[] {
  const [split, setSplit] = useState(() => ({ markdown, ...splitIntoChunks(markdown) }))
  if (split.markdown === markdown) return split.chunks
  const next = { markdown, ...splitIntoChunks(markdown, split) }
  setSplit(next)
  return next.chunks
}

/**
 * Agent prose. Raw HTML never renders. A long text renders in chunks (`chunks.ts`), so a streamed
 * update re-renders, lays out and paints the live tail instead of the whole message. Streaming
 * mode splits each chunk into memoized blocks, and the mode never changes: static mode renders
 * one tree, so switching when a message finishes would rebuild all of it. Finishing only turns
 * off incomplete-markdown repair.
 */
function MarkdownImpl({
  markdown,
  streaming = false,
  className,
}: {
  markdown: string
  streaming?: boolean
  className?: string
}) {
  // Finishing re-renders every code block and table to enable their controls; deferring it lets
  // React split that work across frames instead of blocking one.
  const live = useDeferredValue(streaming)
  const chunks = useChunks(markdown)
  return (
    <div className={cn('markdown', className)}>
      {chunks.map((chunk, i) => (
        // By position: when the tail settles, the chunk in its place keeps its rendered blocks.
        <Chunk key={i} markdown={chunk} live={live} />
      ))}
    </div>
  )
}

const Chunk = memo(function Chunk({ markdown, live }: { markdown: string; live: boolean }) {
  return (
    <Streamdown
      mode="streaming"
      parseIncompleteMarkdown={live}
      isAnimating={live}
      skipHtml
      plugins={plugins}
      components={components}
      linkSafety={linkSafety}
      controls={controls}
      codeBlockMaxHeight={480}
      lineNumbers={false}
    >
      {markdown}
    </Streamdown>
  )
})

export default memo(MarkdownImpl)
