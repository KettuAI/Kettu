import { useId, useMemo, useState } from 'react'
import { Download01Icon, SourceCodeIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { CodeBlock } from 'streamdown'
import { bytes } from '@renderer/lib/format'
import {
  BlockAction,
  BlockFrame,
  BlockPicture,
  BlockSpacer,
  PreviewSourceSwitch,
} from './block-frame'
import { fenceFileName } from './code-meta'
import { CodeFrame, type BlockProps } from './code-frame'
import { downloadText } from './download'
import { openPicture } from './open-picture'

interface Picture {
  url: string
  xml: string
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
  sizeOf(svg)
  const xml = new XMLSerializer().serializeToString(svg)
  return {
    url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`,
    xml,
    title: svg.querySelector('title')?.textContent?.trim() || null,
  }
}

/** Whether an attribute gives an image a size of its own: a length, never a percentage. */
function isLength(value: string | null): boolean {
  return (
    value !== null && /^\s*(\d+\.?\d*|\.\d+)\s*[a-z]*\s*$/i.test(value) && parseFloat(value) > 0
  )
}

/**
 * Gives an `<svg>` with neither a width nor a height the size of its view box, or a browser's 300
 * by 150 without one: as an image it would otherwise have no size and shrink to nothing in a box
 * that takes the picture's width. With one of them, the image takes the other from the view box.
 */
function sizeOf(svg: SVGSVGElement): void {
  if (isLength(svg.getAttribute('width')) || isLength(svg.getAttribute('height'))) return
  const [, , width = 0, height = 0] = (svg.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  const boxed = width > 0 && height > 0
  svg.setAttribute('width', String(boxed ? width : 300))
  svg.setAttribute('height', String(boxed ? height : 150))
}

/**
 * An `svg` code block, shown as its bare picture once the block is complete, its source a click
 * away. The picture is an `<img>`, so none of its scripts run and nothing it references loads.
 * While it streams, and when it holds no `<svg>` or does not decode, it is an ordinary code block.
 */
export function SvgBlock(props: BlockProps) {
  const { code, language, meta, isIncomplete } = props
  const { t } = useTranslation('session')
  const key = `svg:${useId()}`
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
  const download = (
    <BlockAction
      label={t('block.download')}
      onClick={() => downloadText(code, downloadName(name), 'image/svg+xml')}
    >
      <HugeiconsIcon icon={Download01Icon} strokeWidth={1.9} aria-hidden />
    </BlockAction>
  )
  if (!source) {
    return (
      <BlockPicture
        src={picture.url}
        alt={picture.title ?? t('svg.alt')}
        data-viewer-key={key}
        open={{
          label: t('media.openLarger'),
          onOpen: (from) =>
            openPicture({
              key,
              xml: picture.xml,
              name: name ? downloadName(name) : null,
              alt: picture.title ?? t('svg.alt'),
              from,
            }),
        }}
        onError={() => setFailed(code)}
        actions={
          <>
            <BlockAction label={t('block.source')} onClick={() => setSource(true)}>
              <HugeiconsIcon icon={SourceCodeIcon} strokeWidth={1.9} aria-hidden />
            </BlockAction>
            {download}
          </>
        }
      />
    )
  }

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
          {download}
        </>
      }
    >
      <CodeBlock code={code} language="svg" lineNumbers />
    </BlockFrame>
  )
}

/** A file name for the saved picture: the fence's own, else its title, else a plain one. */
function downloadName(name: string | null): string {
  const base = (name ?? 'image').split(/[\\/]/).pop() || 'image'
  return base.toLowerCase().endsWith('.svg') ? base : `${base.replace(/[^\w.-]+/g, '-')}.svg`
}
