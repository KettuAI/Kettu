import { useContext, useMemo, useRef, useState } from 'react'
import { BookOpenIcon, CodeIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  CodeBlock,
  CodeBlockContainer,
  CodeBlockCopyButton,
  CodeBlockHeader,
  StreamdownContext,
  type CustomRendererProps,
} from 'streamdown'

interface Picture {
  url: string
  title: string | null
}

/**
 * The block's first `<svg>`, as a `data:` URL. The HTML parser takes what agents write for a web
 * page, such as a missing `xmlns`, `&nbsp;` or a stray `&`, which an image's strict XML parser
 * rejects; serializing gives it back as XML.
 */
function pictureOf(code: string): Picture | null {
  const svg = new DOMParser().parseFromString(code, 'text/html').querySelector('svg')
  if (!svg) return null
  const xml = new XMLSerializer().serializeToString(svg)
  return {
    url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`,
    title: svg.querySelector('title')?.textContent?.trim() || null,
  }
}

/**
 * An `svg` code block, shown as its picture once the block is complete. The picture is an
 * `<img>`, so none of its scripts run and nothing it references loads. While it streams, and when
 * it holds no `<svg>` or does not decode, it is an ordinary code block.
 */
export function SvgBlock({ code, isIncomplete }: CustomRendererProps) {
  const { t } = useTranslation('session')
  const { lineNumbers } = useContext(StreamdownContext)
  const [source, setSource] = useState(false)
  // Switching views mounts a new button, so the one that was pressed hands the focus to it.
  const refocus = useRef(false)
  // The text that failed, so a block whose text changes gets another try.
  const [failed, setFailed] = useState<string | null>(null)
  const picture = useMemo(
    () => (isIncomplete || failed === code ? null : pictureOf(code)),
    [code, isIncomplete, failed],
  )

  const toggle = picture && (
    <button
      type="button"
      aria-label={source ? t('svg.showPreview') : t('svg.showSource')}
      title={source ? t('svg.showPreview') : t('svg.showSource')}
      ref={(button) => {
        if (button && refocus.current) {
          refocus.current = false
          button.focus()
        }
      }}
      onClick={() => {
        refocus.current = true
        setSource(!source)
      }}
    >
      {source ? <BookOpenIcon aria-hidden /> : <CodeIcon aria-hidden />}
    </button>
  )

  if (!picture || source) {
    return (
      <CodeBlock code={code} language="svg" isIncomplete={isIncomplete} lineNumbers={lineNumbers}>
        {toggle}
        <CodeBlockCopyButton code={code} />
      </CodeBlock>
    )
  }
  // The header's controls sit in the same wrapper Streamdown gives a code block's, so they share
  // its styles in globals.css.
  return (
    <CodeBlockContainer language="svg">
      <CodeBlockHeader language="svg" />
      <div className="pointer-events-none absolute z-10 flex items-center">
        <div
          className="pointer-events-auto flex shrink-0 items-center gap-2"
          data-streamdown="code-block-actions"
        >
          {toggle}
          <CodeBlockCopyButton code={code} />
        </div>
      </div>
      <div className="flex justify-center px-3.5 pb-3" data-streamdown="svg-preview">
        {/* A margin of page around the picture, so a shape with round corners keeps them. */}
        <div className="max-w-full rounded-md bg-canvas p-3">
          <img
            src={picture.url}
            alt={picture.title ?? t('svg.alt')}
            decoding="async"
            className="block h-auto max-w-full"
            onError={() => setFailed(code)}
          />
        </div>
      </div>
    </CodeBlockContainer>
  )
}
