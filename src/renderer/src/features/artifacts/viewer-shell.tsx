import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Cancel01Icon } from '@hugeicons/core-free-icons'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { Icon } from '@renderer/components/affect/app-shell'
import { cardIn, cardOut } from '@renderer/lib/motion'
import { cn } from '@renderer/lib/utils'
import {
  EDGE,
  LEFT_W,
  NO_SHELL,
  RIGHT_W,
  ShellContext,
  TIGHT_PX,
  tierOf,
  useShell,
  type Insets,
  type ShellValue,
  type Slot,
} from './viewer-shell-context'
import './viewer-shell.css'

/**
 * What a kind puts into one of the shell's places. The left card and the kind's right card show
 * it only while they are open; the dock and the pill hide while nothing is in them.
 */
export function ViewerSlot({ slot, children }: { slot: Slot; children: ReactNode }) {
  const target = useShell().targets[slot]
  return target ? createPortal(children, target) : null
}

/** The right card's content, one at a time: shown by key, faded across when it changes. */
export interface RightContent {
  key: string
  /** Its body; null for a card the kind fills through its `right` slot. */
  body: ReactNode | null
  onClose: () => void
}

/** The navigator a kind has in the left card. */
export interface LeftCard {
  title: ReactNode
  /** Open when the user has not chosen, at the wide and middle tiers. */
  byDefault: boolean
  open: boolean | null
  onOpenChange: (open: boolean) => void
}

/**
 * One artifact viewer's frame, the same in the main area and in a session's side panel: the bar
 * on top, the content on the shell's ground, and around it the left card, the right card, the dock
 * at the foot and the pill at the top. The cards float over a canvas, which keeps its fit clear of
 * them, and stand beside any other content, which is never covered.
 */
export function ArtifactShell({
  where,
  bar,
  layout,
  ground,
  left,
  right,
  expanded = false,
  children,
}: {
  where: 'main' | 'panel'
  bar: ReactNode
  /** `float`: the cards lie over the content; `beside`: the content gives them room. */
  layout: 'float' | 'beside'
  ground: 'dots' | 'plain'
  left: LeftCard | null
  right: RightContent | null
  expanded?: boolean
  children: ReactNode
}) {
  const { t } = useTranslation(['artifacts', 'common'])
  const reduce = useReducedMotion()
  const root = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [bottomH, setBottomH] = useState(0)
  const [targets, setTargets] = useState<Record<Slot, HTMLElement | null>>(NO_SHELL.targets)
  const tier = tierOf(width || 1280)
  const narrow = tier === 'narrow'

  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Below wide the cards take turns: the right one folds the left, which comes back after it.
  const leftWanted = left ? (left.open ?? (narrow ? false : left.byDefault)) : false
  const leftShown = leftWanted && (tier === 'wide' || !right)
  const rightShown = right !== null

  const leftRoom = leftShown ? LEFT_W + EDGE : 0
  const rightRoom = rightShown && !narrow ? RIGHT_W + EDGE : 0
  // Beside content gives the cards room; over a canvas they only move the fit and the chrome.
  const contentRoom: Insets =
    layout === 'beside' && !narrow ? { left: leftRoom, right: rightRoom } : { left: 0, right: 0 }
  // Narrow, the left card lies over the content, which keeps its fit.
  const insetLeft = layout === 'float' && !narrow ? leftRoom : contentRoom.left
  const insetRight = layout === 'float' ? rightRoom : contentRoom.right
  const chromeLeft = layout === 'float' || narrow ? leftRoom : 0
  const chromeRight = layout === 'float' ? rightRoom : 0
  const bottomRoom = rightShown && narrow ? bottomH + 2 * 8 : 0

  const setTarget = (slot: Slot, el: HTMLElement | null) =>
    setTargets((was) => (was[slot] === el ? was : { ...was, [slot]: el }))
  const leftTarget = useCallback((el: HTMLElement | null) => setTarget('left', el), [])
  const leftHeadTarget = useCallback((el: HTMLElement | null) => setTarget('leftHead', el), [])
  const rightTarget = useCallback((el: HTMLElement | null) => setTarget('right', el), [])
  const dockTarget = useCallback((el: HTMLElement | null) => setTarget('dock', el), [])
  const pillTarget = useCallback((el: HTMLElement | null) => setTarget('pill', el), [])
  // The dock's button reads these when pressed, so the shell's value stays the same across renders.
  const latest = useRef({ left, right, tier })
  useLayoutEffect(() => {
    latest.current = { left, right, tier }
  })
  const hasLeft = left !== null
  const setLeft = useCallback((shown: boolean) => {
    const now = latest.current
    // Below wide, opening the left card puts the right one away.
    if (shown && now.tier !== 'wide') now.right?.onClose()
    now.left?.onOpenChange(shown)
  }, [])
  const tight = width > 0 && width < TIGHT_PX
  const value = useMemo<ShellValue>(
    () => ({
      tier,
      tight,
      insets: { left: insetLeft, right: insetRight },
      targets,
      leftCard: hasLeft ? { shown: leftShown, setShown: setLeft } : null,
    }),
    [tier, tight, insetLeft, insetRight, targets, leftShown, hasLeft, setLeft],
  )

  const bottomCard = useRef<ResizeObserver | null>(null)
  const measureBottom = useCallback((el: HTMLDivElement | null) => {
    bottomCard.current?.disconnect()
    bottomCard.current = null
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setBottomH(Math.round(entry.borderBoxSize[0]?.blockSize ?? 0))
    })
    observer.observe(el)
    bottomCard.current = observer
  }, [])

  const slide = (side: 'left' | 'right' | 'bottom') => {
    if (reduce)
      return { initial: false as const, exit: { opacity: 0, transition: { duration: 0 } } }
    const from = side === 'left' ? { x: -12 } : side === 'right' ? { x: 12 } : { y: 12 }
    return {
      initial: { opacity: 0, filter: 'blur(6px)', ...from },
      animate: { opacity: 1, filter: 'blur(0px)', x: 0, y: 0, transition: cardIn },
      exit: { opacity: 0, filter: 'blur(6px)', ...from, transition: cardOut },
    }
  }

  const style = {
    '--avs-content-l': `${contentRoom.left}px`,
    '--avs-content-r': `${contentRoom.right}px`,
    '--avs-content-b': `${bottomRoom}px`,
    '--avs-chrome-l': `${chromeLeft}px`,
    '--avs-chrome-r': `${chromeRight}px`,
  } as CSSProperties

  return (
    <ShellContext.Provider value={value}>
      <div
        ref={root}
        className="avs"
        data-where={where}
        data-tier={tier}
        data-tight={tight || undefined}
        data-expanded={expanded || undefined}
        style={style}
      >
        {bar}
        <div className="avs-body">
          <div
            className="avs-content"
            data-ground={ground}
            onPointerDownCapture={() => {
              // Narrow, the left card lies over the content, and a press on the content folds it.
              if (narrow && leftShown) left?.onOpenChange(false)
            }}
          >
            {children}
            <div ref={pillTarget} className="avs-pill" />
            <div
              ref={dockTarget}
              role="toolbar"
              aria-label={t('tools.label')}
              className="avs-dock"
            />
          </div>
          <AnimatePresence initial={false}>
            {leftShown && left && (
              <motion.div key="left" className="avs-card" data-side="left" {...slide('left')}>
                <div className="avs-card__head">
                  <div className="avs-card__title">{left.title}</div>
                  <div ref={leftHeadTarget} className="avs-card__acts" />
                  <CardClose
                    label={t('common:actions.close')}
                    onClick={() => left.onOpenChange(false)}
                  />
                </div>
                <div ref={leftTarget} className="avs-card__body" />
              </motion.div>
            )}
          </AnimatePresence>
          <AnimatePresence initial={false}>
            {right && (
              <motion.div
                key={narrow ? 'bottom' : 'right'}
                ref={narrow ? measureBottom : undefined}
                className="avs-card"
                data-side={narrow ? 'bottom' : 'right'}
                {...slide(narrow ? 'bottom' : 'right')}
              >
                <CardClose label={t('common:actions.close')} onClick={right.onClose} floating />
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={right.key}
                    className="avs-card__swap"
                    initial={reduce ? false : { opacity: 0 }}
                    animate={{ opacity: 1, transition: { duration: reduce ? 0 : 0.14 } }}
                    exit={{ opacity: 0, transition: { duration: reduce ? 0 : 0.1 } }}
                  >
                    {right.body ?? <div ref={rightTarget} className="avs-card__slot" />}
                  </motion.div>
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </ShellContext.Provider>
  )
}

function CardClose({
  label,
  onClick,
  floating = false,
}: {
  label: string
  onClick: () => void
  floating?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn('avs-card__close', floating && 'avs-card__close--float')}
    >
      <Icon icon={Cancel01Icon} size={14} />
    </button>
  )
}

/** A button of the dock: an icon, with its words in a tooltip, or a label beside it. */
export function DockButton({
  label,
  icon,
  pressed,
  disabled,
  children,
  onClick,
}: {
  label: string
  icon?: Parameters<typeof Icon>[0]['icon']
  pressed?: boolean
  disabled?: boolean
  /** Words shown beside the icon, where there is room. */
  children?: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={children ? undefined : label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className="avs-dock__btn"
      data-text={children ? '' : undefined}
    >
      {icon && <Icon icon={icon} size={15} />}
      {children}
    </button>
  )
}

/** A hairline between the dock's groups. */
export function DockRule() {
  return <span aria-hidden className="avs-dock__rule" />
}
