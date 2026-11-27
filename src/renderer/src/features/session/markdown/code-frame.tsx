import {
  isValidElement,
  lazy,
  Suspense,
  useContext,
  useState,
  type ComponentProps,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from 'react'
import { TextWrapIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { CodeBlock, useIsCodeFenceIncomplete, type ExtraProps } from 'streamdown'
import { FileTypeIcon } from '@renderer/features/files/file-type-icon'
import { BlockAction, BlockCopy, BlockFrame, BlockSpacer } from './block-frame'
import { fenceFileName, fenceLanguage, fenceStartLine, foldLines } from './code-meta'
import { CommandBar } from './command-bar'
import { isCommandLanguage, useSessionPlatform } from './command'
import { LiveContext, ReplyContext } from './live'
import { SvgBlock } from './svg-block'

let loadedMermaidBlock: ComponentType<BlockProps> | null = null
let mermaidBlockPromise: Promise<{ default: ComponentType<BlockProps> }> | null = null

function loadMermaidBlock(): Promise<{ default: ComponentType<BlockProps> }> {
  mermaidBlockPromise ??= import('./mermaid-block').then((module) => {
    loadedMermaidBlock = module.default
    return module
  })
  return mermaidBlockPromise
}

const MermaidBlock = lazy(loadMermaidBlock)
const MathBlock = lazy(() => import('./math').then((m) => ({ default: m.MathBlock })))

function codeOf(children: ReactNode): string {
  if (typeof children === 'string') return children
  if (isValidElement<{ children?: ReactNode }>(children)) return codeOf(children.props.children)
  if (Array.isArray(children)) return children.map(codeOf).join('')
  return ''
}

/** A fenced block, by its language: maths, an SVG, a diagram, a command in a reply, or code. */
export function BlockCode({ node, className, children }: ComponentProps<'code'> & ExtraProps) {
  const isIncomplete = useIsCodeFenceIncomplete()
  const reply = useContext(ReplyContext)
  const language = /language-(\S+)/.exec(className ?? '')?.[1] ?? ''
  const meta = node?.properties?.metastring
  const code = codeOf(children)
  if (language === 'math') {
    return (
      <Suspense fallback={<MathSource tex={code} />}>
        <MathBlock tex={code} isIncomplete={isIncomplete} />
      </Suspense>
    )
  }
  const props = {
    code,
    language,
    meta: typeof meta === 'string' ? meta : undefined,
    isIncomplete,
  }
  if (language === 'svg') return <SvgBlock {...props} />
  // Windows takes the most languages, so a block no host runs skips the host lookup.
  if (reply !== null && isCommandLanguage(language, 'win32')) {
    return <ReplyCommand sessionId={reply} {...props} />
  }
  if (language === 'mermaid') {
    const Loaded = loadedMermaidBlock
    if (Loaded) return <Loaded {...props} />
    return (
      <Suspense fallback={<CodeFrame {...props} />}>
        <MermaidBlock {...props} />
      </Suspense>
    )
  }
  return <CodeFrame {...props} />
}

/** A shell block of an agent's reply: a command bar when its session's host runs the language. */
function ReplyCommand({ sessionId, ...props }: BlockProps & { sessionId: string }) {
  const platform = useSessionPlatform(sessionId)
  if (platform === null || !isCommandLanguage(props.language, platform)) {
    return <CodeFrame {...props} />
  }
  return <CommandBar sessionId={sessionId} platform={platform} {...props} />
}

/** A formula's source on the block's ground while KaTeX loads. */
function MathSource({ tex }: { tex: string }) {
  return (
    <div data-math-block="">
      <code>{tex.replace(/\n$/, '')}</code>
    </div>
  )
}

export interface BlockProps {
  code: string
  language: string
  meta?: string
  isIncomplete: boolean
}

/**
 * Code in the block frame: its file and language on the left, Wrap and Copy on the right, line
 * numbers, and anything over 20 lines folded to its first lines until opened.
 */
export function CodeFrame({
  code,
  language,
  meta,
  isIncomplete,
  name,
  frameRef,
}: BlockProps & { name?: ReactNode; frameRef?: Ref<HTMLDivElement> }) {
  const { t } = useTranslation('session')
  const [wrap, setWrap] = useState(false)
  // A block that arrives while the reply is being written stays open, so it never shrinks under
  // the reader once its fence closes; one loaded with the history starts folded.
  const live = useContext(LiveContext)
  const [folded, setFolded] = useState(() => !live)
  const lang = fenceLanguage(language)
  const file = fenceFileName(language, meta)
  const startLine = fenceStartLine(meta)
  // A block still being written shows every line, so it never shrinks under the reader.
  const { shown, hidden } = foldLines(code, folded && !isIncomplete)
  const foldable = !isIncomplete && foldLines(code, true).hidden > 0
  return (
    <BlockFrame
      ref={frameRef}
      data-wrap={wrap || undefined}
      // The number column fits the block's last line number.
      style={
        {
          '--code-digits': String((startLine ?? 1) + code.split('\n').length - 1).length,
        } as CSSProperties
      }
      header={
        <>
          {name ?? (file && <FileName path={file} />)}
          {lang && <span className="block-frame-lang">{lang}</span>}
          <BlockSpacer />
          <BlockAction label={t('block.wrap')} aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
            <HugeiconsIcon icon={TextWrapIcon} strokeWidth={1.9} aria-hidden />
          </BlockAction>
          <BlockCopy text={code} label={t('block.copy')} />
        </>
      }
    >
      <CodeBlock
        code={shown}
        language={lang}
        isIncomplete={isIncomplete}
        lineNumbers
        startLine={startLine}
      />
      {foldable && (
        <button
          type="button"
          className="block-frame-more"
          aria-expanded={!folded}
          onClick={() => setFolded(!folded)}
        >
          {folded ? t('block.showMore', { count: hidden }) : t('block.showLess')}
        </button>
      )}
    </BlockFrame>
  )
}

/** A fence's file: its icon, then the name after its folder in a fainter ink. */
function FileName({ path }: { path: string }) {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1
  return (
    <>
      <FileTypeIcon path={path} className="block-frame-icon" />
      <span className="block-frame-name" title={path}>
        {cut > 0 && <span className="block-frame-dir">{path.slice(0, cut)}</span>}
        {path.slice(cut)}
      </span>
    </>
  )
}
