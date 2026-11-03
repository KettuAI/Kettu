import { useMemo, useState } from 'react'
import { ArrowDownToLineIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CodeBlock } from 'streamdown'
import { bytes } from '@renderer/lib/format'
import { BlockAction, BlockFrame, BlockSpacer, PreviewSourceSwitch } from './block-frame'
import { fenceFileName } from './code-meta'
import { CodeFrame, type BlockProps } from './code-frame'
import { downloadText } from './download'

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
 * An `svg` code block, shown as its picture on a checkerboard once the block is complete, so its
 * transparent parts show. The picture is an `<img>`, so none of its scripts run and nothing it
 * references loads. While it streams, and when it holds no `<svg>` or does not decode, it is an
 * ordinary code block.
 */
export function SvgBlock(props: BlockProps) {
  const { code, language, meta, isIncomplete } = props
  const { t } = useTranslation('session')
  const [source, setSource] = useState(false)
  // The text that failed, so a block whose text changes gets another try.
  const [failed, setFailed] = useState<string | null>(null)
  const picture = useMemo(
    () => (isIncomplete || failed === code ? null : pictureOf(code)),
    [code, isIncomplete, failed],
  )
  if (!picture) return <CodeFrame {...props} />

  const file = fenceFileName(language, meta)
  const name = file ?? picture.title
  const size = bytes(new TextEncoder().encode(code).length)
  return (
    <BlockFrame
      header={
        <>
          <span className="block-frame-lang">svg</span>
          <span className="block-frame-name" title={name ?? undefined}>
            {name ? `${name} · ${size}` : size}
          </span>
          <BlockSpacer />
          <PreviewSourceSwitch
            source={source}
            onChange={setSource}
            labels={{
              group: t('block.view'),
              preview: t('block.preview'),
              source: t('block.source'),
            }}
          />
          <BlockAction
            label={t('block.download')}
            onClick={() => downloadText(code, downloadName(file ?? picture.title), 'image/svg+xml')}
          >
            <ArrowDownToLineIcon />
          </BlockAction>
        </>
      }
    >
      {source ? (
        <CodeBlock code={code} language="svg" lineNumbers />
      ) : (
        <div className="block-frame-checker">
          <img
            src={picture.url}
            alt={picture.title ?? t('svg.alt')}
            decoding="async"
            onError={() => setFailed(code)}
          />
        </div>
      )}
    </BlockFrame>
  )
}

/** A file name for the saved picture: the fence's own, else its title, else a plain one. */
function downloadName(name: string | null): string {
  const base = (name ?? 'image').split(/[\\/]/).pop() || 'image'
  return base.toLowerCase().endsWith('.svg') ? base : `${base.replace(/[^\w.-]+/g, '-')}.svg`
}
