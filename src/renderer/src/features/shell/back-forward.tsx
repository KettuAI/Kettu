import { useId, useRef, useState } from 'react'
import { ChevronLeftIcon, ChevronRightIcon, HistoryIcon } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import {
  back,
  forward,
  goToPlace,
  HISTORY_SHORTCUTS,
  historyPlaces,
  showHistory,
} from '@renderer/app/history'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Kbd } from '@renderer/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { formatShortcut } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { useViewStore, type HistoryPlace } from '@renderer/stores/view'
import { PlaceIcon, PlaceTitle } from './place'
import { placeAgo, usePlaceTitle } from './place-title'
import { TITLE_BUTTON } from './title-button'

// How long Back or Forward is held before it lists its places, as a browser's does.
const HOLD_MS = 450
// The places a button's menu lists; Show all history has the rest.
const MENU_PLACES = 12

type Direction = 'back' | 'forward'

/** Back and Forward through the places the window showed. */
export function BackForward() {
  return (
    <>
      <HistoryButton direction="back" />
      <HistoryButton direction="forward" />
    </>
  )
}

function HistoryButton({ direction }: { direction: Direction }) {
  const { t } = useTranslation('shell')
  const enabled = useViewStore((s) => s.history[direction].length > 0)
  const [menu, setMenu] = useState(false)
  const [tip, setTip] = useState(false)
  const id = useId()
  const hold = useRef<ReturnType<typeof setTimeout>>(undefined)
  // Set when a press opened or closed the menu, so its click does not also step.
  const held = useRef(false)
  const label = direction === 'back' ? t('topBar.back') : t('topBar.forward')
  const Icon = direction === 'back' ? ChevronLeftIcon : ChevronRightIcon
  const release = () => clearTimeout(hold.current)
  return (
    <DropdownMenu
      open={menu}
      triggerId={id}
      // A press steps; holding, a right click or the arrow keys list the places.
      onOpenChange={(open, details) => {
        if (!open || details.reason !== 'trigger-press') setMenu(open)
      }}
    >
      <Tooltip open={tip && !menu} onOpenChange={setTip}>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              id={id}
              render={
                <Button
                  variant="quiet"
                  size="icon-compact"
                  aria-label={label}
                  disabled={!enabled}
                  className={TITLE_BUTTON}
                  onPointerDown={(event) => {
                    held.current = menu
                    if (event.button !== 0 || menu) return
                    hold.current = setTimeout(() => {
                      held.current = true
                      setMenu(true)
                    }, HOLD_MS)
                  }}
                  onPointerUp={release}
                  onPointerLeave={release}
                  onClick={() => {
                    if (held.current) held.current = false
                    else if (direction === 'back') back()
                    else forward()
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    release()
                    setMenu(true)
                  }}
                />
              }
            />
          }
        >
          <Icon strokeWidth={1.4} className="size-4.25" />
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" alignOffset={-8}>
          <Destination direction={direction} label={label} />
          <Kbd>{formatShortcut(HISTORY_SHORTCUTS[direction])}</Kbd>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" alignOffset={-8} className="w-82.5">
        <PlacesMenu direction={direction} label={label} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Where the button goes: "Back to" the place it shows, or its plain name without one. */
function Destination({ direction, label }: { direction: Direction; label: string }) {
  const place = useViewStore((s) => historyPlaces(s.history, direction)[0]?.place)
  return place ? <DestinationName direction={direction} place={place} /> : <span>{label}</span>
}

function DestinationName({ direction, place }: { direction: Direction; place: HistoryPlace }) {
  const { t } = useTranslation('shell')
  const title = usePlaceTitle(place)
  return (
    <span className="min-w-0 truncate">
      <Trans
        t={t}
        i18nKey={direction === 'back' ? 'topBar.backTo' : 'topBar.forwardTo'}
        components={{ title: <b className="font-semibold">{title}</b> }}
      />
    </span>
  )
}

/** The places a button can go to, newest first, then the whole history. */
function PlacesMenu({ direction, label }: { direction: Direction; label: string }) {
  const { t } = useTranslation('shell')
  const history = useViewStore((s) => s.history)
  const steps = historyPlaces(history, direction).slice(0, MENU_PLACES)
  const now = useNow()
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel className="h-6.5 text-small text-tertiary">{label}</DropdownMenuLabel>
        {steps.map((step, i) => (
          <DropdownMenuItem key={i} onClick={() => goToPlace(direction, step)}>
            <PlaceIcon place={step.place} />
            <PlaceTitle place={step.place} className="min-w-0 truncate" />
            <DropdownMenuShortcut className="text-hint">
              {placeAgo(step.at, now)}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
        ))}
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => showHistory(true)}>
        <span aria-hidden className="grid size-4 shrink-0 place-items-center text-icon">
          <HistoryIcon className="size-3.75" />
        </span>
        {t('history.showAll')}
        <DropdownMenuShortcut className="text-small">
          {formatShortcut(HISTORY_SHORTCUTS.all)}
        </DropdownMenuShortcut>
      </DropdownMenuItem>
    </>
  )
}
