import { useEffect, useId, useRef, useState } from 'react'
import { Download01Icon, SourceCodeIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { CodeBlock } from 'streamdown'
import { useDark } from '@renderer/hooks/use-dark'
import { useNearView } from '@renderer/features/session/media/near-view'
import { useSettingsStore } from '@renderer/stores/settings'
import { useThemesStore } from '@renderer/stores/themes'
import {
  BlockAction,
  BlockCopy,
  BlockFrame,
  BlockPicture,
  BlockSpacer,
  PreviewSourceSwitch,
} from './block-frame'
import { CodeFrame, type BlockProps } from './code-frame'
import { downloadText } from './download'
import {
  getCachedMermaidPicture,
  getMermaidThemeSnapshot,
  mermaidCacheKey,
  refreshMermaidThemeSnapshot,
  requestMermaidPicture,
  type MermaidRenderResult,
} from './mermaid-render'
import { openPicture } from './open-picture'

/**
 * A Mermaid diagram, drawn in the theme's colors and drawn again when the theme changes, with
 * its source a click away. Mermaid's strict security level sanitizes the labels, and the picture
 * is an image. Rendered SVGs live in a bounded module-level LRU cache so switching back to a
 * session paints immediately without re-running Mermaid. While the block streams it shows as code.
 */
export default function MermaidBlock(props: BlockProps) {
  const { code, isIncomplete } = props
  const { t } = useTranslation('session')
  const dark = useDark()
  const theme = useThemesStore((s) => s.shown)
  const fonts = useSettingsStore((s) => s.settings.appearance.fonts)
  const uid = useId()
  const frameRef = useRef<HTMLDivElement>(null)
  const [source, setSource] = useState(false)
  const [settled, setSettled] = useState<{ key: string; result: MermaidRenderResult } | null>(null)

  const snapshot = getMermaidThemeSnapshot(dark, theme, fonts)
  const cacheKey = mermaidCacheKey(code, snapshot.themeKey)
  const cached = isIncomplete ? undefined : getCachedMermaidPicture(code, snapshot.themeKey)
  const drawn: MermaidRenderResult | null =
    cached ?? (settled?.key === cacheKey ? settled.result : null)

  const hasObserver = typeof IntersectionObserver === 'function'
  const near = useNearView(frameRef, !isIncomplete && !drawn && hasObserver)
  const shouldRender = !isIncomplete && !drawn && (!hasObserver || near)

  useEffect(() => {
    if (!shouldRender) return
    let current = true

    // Re-read computed tokens in case appearance styles settled after render.
    const live = refreshMermaidThemeSnapshot(dark, theme, fonts)
    const liveCacheKey = mermaidCacheKey(code, live.themeKey)

    const handle = requestMermaidPicture({
      code,
      themeKey: live.themeKey,
      variables: live.variables,
    })
    void handle.promise.then((result) => {
      if (!current) return
      setSettled({ key: liveCacheKey, result })
    })
    return () => {
      current = false
      handle.cancel()
    }
  }, [shouldRender, code, snapshot.themeKey, dark, theme, fonts])

  if (isIncomplete) return <CodeFrame {...props} />
  if (!drawn) return <CodeFrame {...props} frameRef={frameRef} />
  const failed = 'error' in drawn
  const download = !failed && (
    <BlockAction
      label={t('block.download')}
      onClick={() => downloadText(drawn.xml, 'diagram.svg', 'image/svg+xml')}
    >
      <HugeiconsIcon icon={Download01Icon} strokeWidth={1.9} aria-hidden />
    </BlockAction>
  )
  if (!failed && !source) {
    const key = `diagram:${uid}`
    return (
      <BlockPicture
        src={drawn.url}
        width={drawn.width}
        alt={t('block.diagram')}
        data-viewer-key={key}
        open={{
          label: t('media.openLarger'),
          onOpen: (from) =>
            openPicture({
              key,
              xml: drawn.xml,
              name: t('block.diagram'),
              alt: t('block.diagram'),
              from,
            }),
        }}
        actions={
          <>
            <BlockAction label={t('block.source')} onClick={() => setSource(true)}>
              <HugeiconsIcon icon={SourceCodeIcon} strokeWidth={1.9} aria-hidden />
            </BlockAction>
            {download}
            <BlockCopy text={code} label={t('block.copy')} />
          </>
        }
      />
    )
  }
  return (
    <BlockFrame
      header={
        <>
          <span className="block-frame-lang">mermaid</span>
          <span className="block-frame-name">{t('block.diagram')}</span>
          <BlockSpacer />
          {!failed && (
            <PreviewSourceSwitch
              source={source}
              onChange={setSource}
              labels={{
                group: t('block.view'),
                preview: t('block.preview'),
                source: t('block.source'),
              }}
            />
          )}
          {download}
          <BlockCopy text={code} label={t('block.copy')} />
        </>
      }
    >
      <CodeBlock code={code} language="mermaid" lineNumbers />
      {failed && (
        <p className="block-frame-error">
          {t('block.diagramFailed')}
          {drawn.error && ` ${drawn.error}`}
        </p>
      )}
    </BlockFrame>
  )
}
