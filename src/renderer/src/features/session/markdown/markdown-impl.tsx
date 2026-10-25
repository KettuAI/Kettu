import 'streamdown/styles.css'
import {
  isValidElement,
  memo,
  useContext,
  useDeferredValue,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from 'react'
import { cjk } from '@streamdown/cjk'
import { createCodePlugin } from '@streamdown/code'
import { ExternalLinkIcon } from 'lucide-react'
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
import { ProjectPathContext, useFileRef } from '@renderer/features/files/file-refs'
import { PrChip } from '@renderer/features/git/pr-chip'
import { SessionIdContext } from '@renderer/features/session/media/grants'
import { LocalMedia } from '@renderer/features/session/media/local-media'
import {
  NamedMedia,
  NamedMediaContext,
  namedMedia,
  type MediaClaim,
} from '@renderer/features/session/media/named'
import { HAN } from '@renderer/lib/han'
import { cn } from '@renderer/lib/utils'
import { splitIntoChunks } from './chunks'
import { localImageTarget, spacedImages } from './local-images'
import { localTarget } from './local-links'
import { remarkPlugins } from './remark'
import { SvgBlock } from './svg-block'

const plugins = {
  code: createCodePlugin({ themes: ['github-light-default', 'github-dark-default'] }),
  cjk,
  renderers: [{ language: 'svg', component: SvgBlock }],
}

const DefaultLink = defaultComponents.a
const DefaultImage = defaultComponents.img
const DefaultParagraph = defaultComponents.p
const DefaultListItem = defaultComponents.li
const DefaultTable = defaultComponents.table

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

/**
 * An image: a local file from the media scheme, a remote one as a link to it, since the CSP
 * loads nothing remote, or a `data:` or `blob:` picture as it comes. Anything else, such as
 * `//host/x.png`, would resolve against the page, so it stays text.
 */
function MarkdownImage(props: ComponentProps<'img'> & ExtraProps) {
  const src = typeof props.src === 'string' ? props.src : ''
  const local = localImageTarget(src)
  if (local !== null) return <LocalMedia key={local} path={local} alt={props.alt ?? ''} image />
  const remote = /^https?:/i.test(src) ? URL.parse(src) : null
  if (remote) {
    return (
      <DefaultLink href={src}>
        <ExternalLinkIcon className="mr-0.5 inline size-3 align-[-0.1em]" />
        {remote.host}
      </DefaultLink>
    )
  }
  if (/^(?:data|blob):/i.test(src)) return <DefaultImage {...props} />
  return <span title={src}>{props.alt}</span>
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

/**
 * The media files a block's file references name, shown under it, each once per message and only
 * under the first block that names it.
 */
function MediaUnder({ node }: ExtraProps) {
  const named = useContext(NamedMediaContext)
  const projectPath = useContext(ProjectPathContext)
  const sessionId = useContext(SessionIdContext)
  const enabled = !!projectPath && !!sessionId && !!named
  const paths = namedMedia(node)
  const key = paths.join('\0')
  const ref = useRef<HTMLDivElement>(null)
  const [claim, setClaim] = useState<MediaClaim<Element> | null>(null)
  useSyncExternalStore(named?.subscribe ?? noSubscribe, named?.getVersion ?? noVersion)
  useLayoutEffect(() => {
    const at = ref.current
    if (!at || !named || key === '') return
    const next = { at, paths: key.split('\0') }
    setClaim(next)
    return named.claim(next)
  }, [named, key])
  if (!enabled || paths.length === 0) return null
  const shown = claim && named ? named.shown(claim) : []
  return (
    // Empty until it shows a file, which hides it (globals.css).
    <div ref={ref} data-media-block="" className="flex flex-col items-start gap-3">
      {shown.map((path) => (
        <LocalMedia key={path} path={path} />
      ))}
    </div>
  )
}

const noSubscribe = () => () => {}
const noVersion = () => 0

function Paragraph(props: ComponentProps<'p'> & ExtraProps) {
  return (
    <>
      <DefaultParagraph {...props} />
      <MediaUnder node={props.node} />
    </>
  )
}

function ListItem({ children, ...props }: ComponentProps<'li'> & ExtraProps) {
  return (
    <DefaultListItem {...props}>
      {children}
      <MediaUnder node={props.node} />
    </DefaultListItem>
  )
}

function Table(props: ComponentProps<'table'> & ExtraProps) {
  return (
    <>
      <DefaultTable {...props} />
      <MediaUnder node={props.node} />
    </>
  )
}

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

const components: Components = {
  a: Link,
  img: MarkdownImage,
  p: Paragraph,
  li: ListItem,
  table: Table,
  inlineCode: InlineCode,
  em: Emphasis,
}

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
  const [named] = useState(() => new NamedMedia())
  return (
    <div className={cn('markdown', className)}>
      <NamedMediaContext value={named}>
        {chunks.map((chunk, i) => (
          // By position: when the tail settles, the chunk in its place keeps its rendered blocks.
          <Chunk key={i} markdown={chunk} live={live} />
        ))}
      </NamedMediaContext>
    </div>
  )
}

const Chunk = memo(function Chunk({ markdown, live }: { markdown: string; live: boolean }) {
  const source = useMemo(() => spacedImages(markdown), [markdown])
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
      {source}
    </Streamdown>
  )
})

export default memo(MarkdownImpl)
