import 'streamdown/styles.css'
import {
  isValidElement,
  memo,
  useDeferredValue,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import { cjk } from '@streamdown/cjk'
import { createCodePlugin } from '@streamdown/code'
import { useTranslation } from 'react-i18next'
import {
  defaultComponents,
  defaultRemarkPlugins,
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
import { localLinks, localTarget } from './local-links'

const plugins = {
  code: createCodePlugin({ themes: ['github-light-default', 'github-dark-default'] }),
  cjk,
}

const DefaultLink = defaultComponents.a

/** A link: a pull request chip, a project file, or the default link with its safety check. */
function Link(props: ComponentProps<'a'> & ExtraProps) {
  const raw = typeof props.href === 'string' ? props.href : ''
  const local = localTarget(raw)
  const href = local ?? raw
  const file = useFileRef(href)
  if (GITHUB_PULL_REQUEST_URL.test(href)) return <PrChip url={href} />
  if (file) return <FileLink file={file} />
  // A local path that is not one of the project's files has nowhere to go.
  if (local !== null) return <span title={local}>{props.children}</span>
  return <DefaultLink {...props} />
}

/** Inline code, which is a file chip when it is a path in the project. */
function InlineCode({ className, children }: ComponentProps<'code'> & ExtraProps) {
  const file = useFileRef(typeof children === 'string' ? children : null)
  if (file) return <FileLink file={file} />
  return (
    <code className={className} data-streamdown="inline-code">
      {children}
    </code>
  )
}

// Chinese has no italics, so emphasis in Chinese text is marked for a step of weight instead.
const HAN = /\p{Script=Han}/u

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children)
  return ''
}

function Emphasis({ children, className }: ComponentProps<'em'> & ExtraProps) {
  return (
    <em className={className} data-cjk-emphasis={HAN.test(textOf(children)) ? '' : undefined}>
      {children}
    </em>
  )
}

const components: Components = { a: Link, inlineCode: InlineCode, em: Emphasis }

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

const remarkPlugins = [...Object.values(defaultRemarkPlugins), localLinks]

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
      remarkPlugins={remarkPlugins}
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
