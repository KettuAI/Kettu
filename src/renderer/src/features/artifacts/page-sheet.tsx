import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDown01Icon,
  ArrowReloadHorizontalIcon,
  ComputerIcon,
  Copy01Icon,
  FitToScreenIcon,
  LinkSquare02Icon,
  MoreHorizontalIcon,
  SmartPhone01Icon,
  Tablet01Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { PageErrors } from '@shared/artifact-runtime/page-errors'
import { Dropdown, Icon, Popover, type MenuItem } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import {
  PAGE_WIDTHS,
  setPageWidth,
  usePageWidth,
  type PageWidth,
} from '@renderer/stores/artifact-page-width'
import { CompareDock, type CompareSwitch } from './compare-dock'
import type { ArtifactEditor } from './editor'
import { errorCount, errorLines, errorPlace } from './page-error-handoff'
import { clearPageErrors, usePageErrors } from './page-errors'
import { PageFrame, Waiting } from './page-frame'
import { framePageUrl, type ShownVersion } from './use-artifact'
import { DockButton, DockRule, ViewerSlot } from './viewer-shell'
import { useShell } from './viewer-shell-context'
import { WriterTag } from './viewer-states'
import './page-sheet.css'

/** The ground around the sheet, the band a pill takes above it and the room the dock takes. */
const EDGE = 8
const BAND = 56
const DOCK = 58

interface Geometry {
  left: number
  top: number
  width: number
  /** The width the page is laid out at, before it is scaled. */
  layout: number
  scale: number
}

function geometry(room: number, width: PageWidth, band: boolean): Geometry {
  const top = band ? BAND : EDGE
  const free = Math.max(120, room - 2 * EDGE)
  if (width === 'fill') return { left: EDGE, top, width: free, layout: free, scale: 1 }
  if (width <= free) {
    return { left: EDGE + (free - width) / 2, top, width, layout: width, scale: 1 }
  }
  return { left: EDGE, top, width: free, layout: width, scale: free / width }
}

/** What a sheet hands to an agent: the errors to fix, or the page to ask about. */
export interface SheetAgent {
  /** The agent's name, for "Ask Claude Code" and "Sent to Claude Code". */
  name: string
  mark: ReactNode
  ask: (() => void) | null
  fixErrors: (pages: readonly PageErrors[]) => Promise<boolean>
}

/**
 * A web page artifact as one rounded sheet on the shell's ground, 8 px clear of it and of the dock
 * under it: laid out at the width chosen for the artifact, centred when narrower than the room and
 * scaled down when wider. It takes clicks only in View; the editor holds it still otherwise.
 */
export function PageSheet({
  id,
  url,
  shown,
  title,
  reloads,
  since,
  editor,
  band,
  before,
  stopped,
  onRestart,
  onReload,
  onBrowser,
  compare,
  agent,
  writer,
}: {
  id: string
  url: string
  shown: ShownVersion
  title: string
  reloads: number
  since: number
  editor?: ArtifactEditor
  /** Whether a pill sits above the sheet, which moves down a band for it. */
  band: boolean
  /** The version shown when it is earlier than the newest, for its tag. */
  before: number | null
  stopped: boolean
  onRestart: () => void
  onReload: () => void
  onBrowser: (() => void) | null
  compare: CompareSwitch | null
  agent: SheetAgent | null
  /** The agent whose running turn writes the page, which holds it whole until the turn ends. */
  writer: { name: string; mark: ReactNode } | null
}) {
  const { t } = useTranslation('artifacts')
  const root = useRef<HTMLDivElement>(null)
  // The cover lies over the sheet, outside the page's scale.
  const [ready, setReady] = useState(false)
  const [room, setRoom] = useState(0)
  const width = usePageWidth(id)
  const origin = url.slice(0, -1)
  const errors = usePageErrors(origin)
  const { tier } = useShell()

  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setRoom(Math.round(entry.contentRect.width))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // What the page reported belongs to the load it came from: another load starts with none.
  const src = framePageUrl(url, shown)
  useEffect(() => clearPageErrors(origin), [origin, src, reloads, stopped])

  const g = geometry(room || 1280, width, band)
  const fill = width === 'fill'

  return (
    <>
      <div ref={root} className="aps-room">
        {room > 0 && (
          <div
            className="aps-sheet"
            data-stopped={stopped || undefined}
            data-writing={writer ? '' : undefined}
            style={{ left: g.left, top: g.top, width: g.width, bottom: DOCK }}
          >
            {stopped ? (
              <div role="alert" className="aps-stopped">
                <b>{t('viewer.stoppedTitle')}</b>
                <span>{t('viewer.stoppedDescription')}</span>
                <Button
                  size="sm"
                  icon={<Icon icon={ArrowReloadHorizontalIcon} size={14} />}
                  onClick={onRestart}
                >
                  {t('viewer.reload')}
                </Button>
              </div>
            ) : (
              <div
                className="aps-scaler"
                style={
                  fill
                    ? undefined
                    : {
                        width: g.layout,
                        height: `${100 / g.scale}%`,
                        transform: g.scale === 1 ? undefined : `scale(${g.scale})`,
                      }
                }
              >
                <PageFrame
                  key={url}
                  url={url}
                  src={src}
                  title={title}
                  reloads={reloads}
                  since={since}
                  editor={editor}
                  scale={g.scale}
                  cover={false}
                  onReady={setReady}
                />
              </div>
            )}
            {!stopped && !ready && <Waiting since={since} id={id} />}
          </div>
        )}
        {room > 0 && writer && (
          <WriterTag
            mark={writer.mark}
            name={writer.name}
            className="aps-writer"
            style={{ left: g.left, top: g.top - 12 }}
          />
        )}
        {/* Narrow, the pill above takes the band's width and says which version this is. */}
        {room > 0 && before !== null && tier !== 'narrow' && (
          <span className="aps-before" style={{ left: g.left, top: g.top - 26 }}>
            {t('sheet.before', { version: before })}
          </span>
        )}
      </div>
      <ViewerSlot slot="dock">
        <WidthMenu id={id} width={width} scale={g.scale} />
        <DockRule />
        <DockButton
          label={t('viewer.reload')}
          icon={ArrowReloadHorizontalIcon}
          onClick={stopped ? onRestart : onReload}
        />
        <SheetDockRest
          onBrowser={onBrowser}
          compare={compare}
          errors={errors}
          agent={agent}
          onCopy={() => copyErrors(errors)}
        />
      </ViewerSlot>
    </>
  )
}

function copyErrors(pages: readonly PageErrors[]): void {
  void navigator.clipboard
    .writeText(errorLines(pages).join('\n'))
    .catch((error: unknown) => toast(errorMessage(error), undefined, { tone: 'warning' }))
}

function SheetDockRest({
  onBrowser,
  compare,
  errors,
  agent,
  onCopy,
}: {
  onBrowser: (() => void) | null
  compare: CompareSwitch | null
  errors: readonly PageErrors[]
  agent: SheetAgent | null
  onCopy: () => void
}) {
  const { t } = useTranslation('artifacts')
  const { tier } = useShell()
  const narrow = tier === 'narrow'
  const ask = agent?.ask ?? null
  const more: MenuItem[] = narrow
    ? [
        ...(onBrowser
          ? [{ label: t('viewer.openInBrowser'), icon: LinkSquare02Icon, onSelect: onBrowser }]
          : []),
        ...(ask && agent
          ? [
              {
                label: t('sheet.ask', { agent: agent.name }),
                logo: agent.mark,
                onSelect: ask,
              },
            ]
          : []),
      ]
    : []
  return (
    <>
      {!narrow && onBrowser && (
        <DockButton label={t('viewer.openInBrowser')} icon={LinkSquare02Icon} onClick={onBrowser} />
      )}
      {compare && <CompareDock compare={compare} />}
      {errors.length > 0 && <ErrorChip errors={errors} agent={agent} onCopy={onCopy} />}
      {narrow
        ? more.length > 0 && (
            <>
              <DockRule />
              <Dropdown
                side="top"
                align="end"
                items={more}
                trigger={({ open, toggle }) => (
                  <button
                    type="button"
                    aria-label={t('viewer.more')}
                    title={t('viewer.more')}
                    aria-expanded={open}
                    onClick={toggle}
                    className="avs-dock__btn"
                  >
                    <Icon icon={MoreHorizontalIcon} size={15} />
                  </button>
                )}
              />
            </>
          )
        : ask &&
          agent && (
            <>
              <DockRule />
              <button
                type="button"
                title={t('sheet.ask', { agent: agent.name })}
                aria-label={tier === 'middle' ? t('sheet.ask', { agent: agent.name }) : undefined}
                onClick={ask}
                className="avs-dock__btn aps-ask"
                data-text={tier === 'middle' ? undefined : ''}
              >
                <span className="aps-ask__mark" aria-hidden>
                  {agent.mark}
                </span>
                {tier !== 'middle' && t('sheet.ask', { agent: agent.name })}
              </button>
            </>
          )}
    </>
  )
}

/** How long "Sent to" stays before the error popover closes. */
const SENT_MS = 2_400

const WIDTH_ICON = { 1280: ComputerIcon, 768: Tablet01Icon, 390: SmartPhone01Icon } as const

/** Fill, or a device's width: "1280 · 78%" on the button while that width is scaled down. */
function WidthMenu({ id, width, scale }: { id: string; width: PageWidth; scale: number }) {
  const { t } = useTranslation('artifacts')
  const name = (w: PageWidth) => (w === 'fill' ? t('sheet.width.fill') : t(`sheet.width.${w}`))
  const label =
    width !== 'fill' && scale < 1
      ? t('sheet.width.scaled', { width, percent: Math.round(scale * 100) })
      : name(width)
  const items: MenuItem[] = [
    {
      label: name('fill'),
      icon: FitToScreenIcon,
      checked: width === 'fill',
      onSelect: () => setPageWidth(id, 'fill'),
    },
    ...PAGE_WIDTHS.map((w, i) => ({
      label: name(w),
      icon: WIDTH_ICON[w],
      checked: width === w,
      divider: i === 0,
      onSelect: () => setPageWidth(id, w),
    })),
  ]
  return (
    <Dropdown
      side="top"
      align="start"
      items={items}
      title={t('sheet.width.label')}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          aria-label={t('sheet.width.button', { width: label })}
          aria-expanded={open}
          aria-haspopup="menu"
          onClick={toggle}
          className="avs-dock__btn aps-width"
          data-text=""
        >
          <span className="aps-width__label">{label}</span>
          <Icon icon={ArrowDown01Icon} size={13} />
        </button>
      )}
    />
  )
}

/** "1 error" while the page has reported any: what it said, to copy or to hand to the agent. */
function ErrorChip({
  errors,
  agent,
  onCopy,
}: {
  errors: readonly PageErrors[]
  agent: SheetAgent | null
  onCopy: () => void
}) {
  const { t } = useTranslation('artifacts')
  const [open, setOpen] = useState(false)
  const [sent, setSent] = useState(false)
  const [sending, setSending] = useState(false)
  const count = errorCount(errors)
  const close = () => {
    setOpen(false)
    setSent(false)
  }
  // Said, the popover goes by itself.
  useEffect(() => {
    if (!sent) return
    const timer = setTimeout(() => {
      setOpen(false)
      setSent(false)
    }, SENT_MS)
    return () => clearTimeout(timer)
  }, [sent])
  const fix = () => {
    if (!agent || sending) return
    setSending(true)
    agent
      .fixErrors(errors)
      .then((done) => {
        if (done) setSent(true)
        else close()
      })
      .catch((error: unknown) =>
        toast(t('sheet.errors.failed', { error: errorMessage(error) }), undefined, {
          tone: 'warning',
        }),
      )
      .finally(() => setSending(false))
  }
  const many = errors.length > 1
  return (
    <>
      <DockRule />
      <span className="ui-as-anchor aps-errors">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => (open ? close() : setOpen(true))}
          className="avs-dock__btn aps-errchip"
          data-text=""
        >
          <span className="aps-errchip__dot" aria-hidden />
          {t('sheet.errors.chip', { count })}
        </button>
        <Popover open={open} onClose={close} side="top" align="end" className="aps-errpop">
          {sent && agent ? (
            <span role="status" className="aps-errpop__sent">
              <Icon icon={Tick02Icon} size={15} />
              {t('sheet.errors.sent', { agent: agent.name })}
            </span>
          ) : (
            <span className="aps-errpop__in">
              <b>{t('sheet.errors.title', { count })}</b>
              <span className="aps-errpop__list">
                {errors.map((page) => (
                  <span key={page.path} className="aps-errpop__page">
                    {many && <small className="aps-errpop__path">{page.path}</small>}
                    {page.errors.map((error, i) => {
                      const place = errorPlace(error)
                      return (
                        <span key={i} className="aps-errpop__code">
                          <code>{error.message}</code>
                          <small>
                            {error.kind === 'rejection'
                              ? place
                                ? t('sheet.errors.rejectionAt', { place })
                                : t('sheet.errors.rejection')
                              : (place ?? page.path)}
                          </small>
                        </span>
                      )
                    })}
                    {page.dropped > 0 && (
                      <small className="aps-errpop__more">
                        {t('sheet.errors.more', { count: page.dropped })}
                      </small>
                    )}
                  </span>
                ))}
              </span>
              <span className="aps-errpop__acts">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Icon icon={Copy01Icon} size={14} />}
                  onClick={onCopy}
                >
                  {t('sheet.errors.copy')}
                </Button>
                {agent && (
                  <Button
                    size="sm"
                    loading={sending}
                    icon={<span className="aps-ask__mark">{agent.mark}</span>}
                    onClick={fix}
                  >
                    {t('sheet.errors.fix', { agent: agent.name })}
                  </Button>
                )}
              </span>
            </span>
          )}
        </Popover>
      </span>
    </>
  )
}
