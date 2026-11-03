import 'streamdown/styles.css'
import {
  isValidElement,
  lazy,
  memo,
  Suspense,
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
import { CheckIcon } from 'lucide-react'
import { defaultComponents, Streamdown, type Components, type ExtraProps } from 'streamdown'
import { FileLink } from '@renderer/features/files/file-link'
import { ProjectPathContext, useFileRef } from '@renderer/features/files/file-refs'
import { ConfirmedLink } from '@renderer/features/session/link-confirm'
import { SessionIdContext } from '@renderer/features/session/media/grants'
import { LocalMedia, MediaRows } from '@renderer/features/session/media/local-media'
import { MediaGrid } from '@renderer/features/session/media/media-grid'
import {
  NamedMedia,
  NamedMediaContext,
  namedMedia,
  type MediaClaim,
} from '@renderer/features/session/media/named'
import { HAN } from '@renderer/lib/han'
import { cn } from '@renderer/lib/utils'
import { splitIntoChunks } from './chunks'
import { codeThemeInput, useCodeThemes, type CodeThemes } from './code-themes'
import { localImageTarget, pictureRun, spacedImages } from './local-images'
import { localTarget } from './local-links'
import { remarkPlugins } from './remark'
import { BlockCode } from './code-frame'
import { MarkdownTable } from './markdown-table'
import { LiveContext } from './live'

// KaTeX, its styles and fonts load with the first formula, not with every reply.
const InlineMath = lazy(() => import('./math').then((m) => ({ default: m.InlineMath })))

// Fenced blocks go through BlockCode, which picks maths, SVG, diagrams or code by language.
function createPlugins({ light, dark }: CodeThemes) {
  return {
    code: createCodePlugin({ themes: [codeThemeInput(light), codeThemeInput(dark)] }),
    cjk,
  }
}

type Plugins = ReturnType<typeof createPlugins>

// One set per pair of code themes, shared by every chunk: Streamdown's context depends on it, and
// a new object would re-render every code block.
const pluginsByThemes = new Map<string, Plugins>()

function pluginsFor(themes: CodeThemes): Plugins {
  const key = `${themes.light} ${themes.dark}`
  let plugins = pluginsByThemes.get(key)
  if (!plugins) {
    plugins = createPlugins(themes)
    pluginsByThemes.set(key, plugins)
  }
  return plugins
}

const DefaultImage = defaultComponents.img
const DefaultParagraph = defaultComponents.p
const DefaultListItem = defaultComponents.li

// Streamdown's href for a link still streaming in, drawn as a link that opens nothing.
const INCOMPLETE_LINK = 'streamdown:incomplete-link'

function isWebLink(href: string): boolean {
  const protocol = URL.parse(href)?.protocol
  return protocol === 'http:' || protocol === 'https:'
}

/** A link: a project file, or a web link with its site's icon. */
function Link(props: ComponentProps<'a'> & ExtraProps) {
  const raw = typeof props.href === 'string' ? props.href : ''
  const local = localTarget(raw)
  const href = local ?? raw
  const file = useFileRef(href)
  if (file) return <FileLink file={file} />
  // A local path that is not one of the project's files has nowhere to go, and main opens
  // nothing but web links.
  if (local !== null) return <span title={local}>{props.children}</span>
  if (raw === INCOMPLETE_LINK) return <span className="thread-link">{props.children}</span>
  if (!isWebLink(raw)) return <span title={raw}>{props.children}</span>
  return <ConfirmedLink url={raw}>{props.children}</ConfirmedLink>
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
    return <ConfirmedLink url={src}>{remote.host}</ConfirmedLink>
  }
  if (/^(?:data|blob):/i.test(src)) return <DefaultImage {...props} />
  return <span title={src}>{props.alt}</span>
}

/** Inline code, which is a file chip when it is a path in the project, or a formula. */
function InlineCode({ className, children }: ComponentProps<'code'> & ExtraProps) {
  const math = !!className?.includes('language-math')
  const file = useFileRef(typeof children === 'string' && !math ? children : null)
  if (math) {
    const tex = textOf(children)
    return (
      <Suspense fallback={<code data-streamdown="inline-code">{tex}</code>}>
        <InlineMath tex={tex} />
      </Suspense>
    )
  }
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
      <MediaRows paths={shown} />
    </div>
  )
}

const noSubscribe = () => () => {}
const noVersion = () => 0

function Paragraph(props: ComponentProps<'p'> & ExtraProps) {
  const projectPath = useContext(ProjectPathContext)
  const sessionId = useContext(SessionIdContext)
  // Outside a session the pictures cannot be read, so they stay their alt text.
  const pictures = projectPath && sessionId ? pictureRun(props.node) : null
  if (pictures) {
    return (
      <div data-media-block="">
        <MediaGrid paths={pictures} images />
      </div>
    )
  }
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
      <MarkdownTable {...props} />
      <MediaUnder node={props.node} />
    </>
  )
}

/** A task list's box: checked or not as the agent wrote it, and never something to click. */
function TaskCheckbox({ type, checked }: ComponentProps<'input'> & ExtraProps) {
  if (type !== 'checkbox') return null
  return (
    <span data-task-box="" role="checkbox" aria-checked={!!checked} aria-disabled>
      {checked && <CheckIcon aria-hidden strokeWidth={1.6} />}
    </span>
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
  code: BlockCode,
  inlineCode: InlineCode,
  input: TaskCheckbox,
  em: Emphasis,
}

// The link component opens links itself (web-link.tsx), so Streamdown's own check stays off.
const linkSafety = { enabled: false }

// The blocks and tables draw their own actions (code-frame.tsx, markdown-table.tsx).
const controls = false

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
  const themes = useCodeThemes()
  const plugins = useMemo(() => pluginsFor(themes), [themes])
  return (
    <LiveContext value={live}>
      {/* The last-block rules in globals.css name the chunks by this class. */}
      <Streamdown
        className="markdown-chunk"
        mode="streaming"
        parseIncompleteMarkdown={live}
        isAnimating={live}
        skipHtml
        plugins={plugins}
        remarkPlugins={remarkPlugins}
        components={components}
        linkSafety={linkSafety}
        controls={controls}
        codeBlockMaxHeight={0}
        tableMaxHeight={0}
        lineNumbers={false}
      >
        {source}
      </Streamdown>
    </LiveContext>
  )
})

export default memo(MarkdownImpl)
