import {
  isValidElement,
  lazy,
  Suspense,
  useContext,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import { WrapTextIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CodeBlock, useIsCodeFenceIncomplete, type ExtraProps } from 'streamdown'
import { BlockAction, BlockCopy, BlockFrame, BlockSpacer } from './block-frame'
import { fenceFileName, fenceLanguage, foldLines } from './code-meta'
import { LiveContext } from './live'
import { SvgBlock } from './svg-block'

const MermaidBlock = lazy(() => import('./mermaid-block'))
const MathBlock = lazy(() => import('./math').then((m) => ({ default: m.MathBlock })))

function codeOf(children: ReactNode): string {
  if (typeof children === 'string') return children
  if (isValidElement<{ children?: ReactNode }>(children)) return codeOf(children.props.children)
  if (Array.isArray(children)) return children.map(codeOf).join('')
  return ''
}

/** A fenced block, by its language: maths, an SVG, a diagram, or code. */
export function BlockCode({ node, className, children }: ComponentProps<'code'> & ExtraProps) {
  const isIncomplete = useIsCodeFenceIncomplete()
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
  if (language === 'mermaid') {
    return (
      <Suspense fallback={<CodeFrame {...props} />}>
        <MermaidBlock {...props} />
      </Suspense>
    )
  }
  return <CodeFrame {...props} />
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
 * Code in the block frame: its language and file on the left, Wrap and Copy on the right, line
 * numbers, and anything over 20 lines folded to its first lines until opened.
 */
export function CodeFrame({
  code,
  language,
  meta,
  isIncomplete,
  name,
}: BlockProps & { name?: ReactNode }) {
  const { t } = useTranslation('session')
  const [wrap, setWrap] = useState(false)
  // A block that arrives while the reply is being written stays open, so it never shrinks under
  // the reader once its fence closes; one loaded with the history starts folded.
  const live = useContext(LiveContext)
  const [folded, setFolded] = useState(() => !live)
  const lang = fenceLanguage(language)
  const file = fenceFileName(language, meta)
  // A block still being written shows every line, so it never shrinks under the reader.
  const { shown, hidden } = foldLines(code, folded && !isIncomplete)
  const foldable = !isIncomplete && foldLines(code, true).hidden > 0
  return (
    <BlockFrame
      data-wrap={wrap || undefined}
      header={
        <>
          {lang && <span className="block-frame-lang">{lang}</span>}
          {name ??
            (file && (
              <span className="block-frame-name" title={file}>
                {file}
              </span>
            ))}
          <BlockSpacer />
          <BlockAction label={t('block.wrap')} aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
            <WrapTextIcon />
          </BlockAction>
          <BlockCopy text={code} label={t('block.copy')} />
        </>
      }
    >
      <CodeBlock code={shown} language={lang} isIncomplete={isIncomplete} lineNumbers />
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
