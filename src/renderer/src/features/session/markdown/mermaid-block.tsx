import { useEffect, useId, useState } from 'react'
import { createMermaidPlugin } from '@streamdown/mermaid'
import { useTranslation } from 'react-i18next'
import { CodeBlock } from 'streamdown'
import { useDark } from '@renderer/hooks/use-dark'
import { useThemesStore } from '@renderer/stores/themes'
import { BlockCopy, BlockFrame, BlockSpacer, PreviewSourceSwitch } from './block-frame'
import { CodeFrame, type BlockProps } from './code-frame'

const plugin = createMermaidPlugin()

/**
 * The diagram's colors from the theme's tokens, read as values: Mermaid derives shades from them,
 * which a `var()` would defeat.
 */
function themeVariables(): Record<string, string> {
  const style = getComputedStyle(document.documentElement)
  const token = (name: string) => style.getPropertyValue(name).trim()
  const surface = token('--bg-surface')
  const text = token('--text-primary')
  const line = token('--border-default')
  return {
    background: surface,
    mainBkg: surface,
    primaryColor: surface,
    secondaryColor: token('--bg-subtle'),
    tertiaryColor: token('--bg-subtle'),
    primaryBorderColor: line,
    secondaryBorderColor: line,
    tertiaryBorderColor: line,
    nodeBorder: line,
    clusterBkg: token('--bg-subtle'),
    clusterBorder: line,
    primaryTextColor: text,
    secondaryTextColor: text,
    tertiaryTextColor: text,
    textColor: text,
    titleColor: text,
    edgeLabelBackground: surface,
    lineColor: token('--border-strong'),
    fontFamily: getComputedStyle(document.body).fontFamily || 'sans-serif',
    fontSize: '12px',
  }
}

type Drawn = { url: string; width: number } | { error: string } | null

/**
 * The diagram as a picture: an `<img>` runs none of the SVG's scripts and loads nothing it
 * references. Mermaid sizes its SVG to its container, so the picture takes the size its view box
 * gives it instead.
 */
function pictureOf(svg: string): { url: string; width: number } | null {
  const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
  if (root.nodeName !== 'svg') return null
  const [, , width, height] = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number)
  if (!width || !height) return null
  root.setAttribute('width', String(width))
  root.setAttribute('height', String(height))
  root.removeAttribute('style')
  const xml = new XMLSerializer().serializeToString(root)
  return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`, width }
}

/**
 * A Mermaid diagram, drawn in the theme's colors and drawn again when the theme changes, with
 * its source a click away. Mermaid's strict security level sanitizes the labels, and the picture
 * is an image. While the block streams it shows as code.
 */
export default function MermaidBlock(props: BlockProps) {
  const { code, isIncomplete } = props
  const { t } = useTranslation('session')
  const dark = useDark()
  const theme = useThemesStore((s) => s.shown)
  const id = `mermaid-${useId().replace(/[^\w-]/g, '')}`
  const [source, setSource] = useState(false)
  const [drawn, setDrawn] = useState<Drawn>(null)

  useEffect(() => {
    if (isIncomplete) return
    let current = true
    const mermaid = plugin.getMermaid({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: themeVariables(),
      // Nodes take the cards' 6 px corners.
      themeCSS: '.node rect { rx: 6px; ry: 6px; }',
      flowchart: { htmlLabels: false },
    })
    mermaid.render(id, code).then(
      ({ svg }) => {
        if (!current) return
        const picture = pictureOf(svg)
        setDrawn(picture ?? { error: 'Mermaid drew no picture' })
      },
      (error: unknown) =>
        current && setDrawn({ error: error instanceof Error ? error.message : String(error) }),
    )
    return () => {
      current = false
    }
  }, [code, isIncomplete, id, dark, theme])

  if (isIncomplete || !drawn) return <CodeFrame {...props} />
  const failed = 'error' in drawn
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
          <BlockCopy text={code} label={t('block.copy')} />
        </>
      }
    >
      {failed || source ? (
        <>
          <CodeBlock code={code} language="mermaid" lineNumbers />
          {failed && <p className="block-frame-error">{drawn.error}</p>}
        </>
      ) : (
        <div className="block-frame-diagram">
          <img src={drawn.url} width={drawn.width} alt={t('block.diagram')} decoding="async" />
        </div>
      )}
    </BlockFrame>
  )
}
