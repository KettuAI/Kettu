import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { goToPlace, historyPlaces, showHistory, useHistoryDialog } from '@renderer/app/history'
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@renderer/components/ui/combobox'
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog'
import { useNow } from '@renderer/lib/use-now'
import { placeOf, useViewStore, type HistoryPlace, type Step } from '@renderer/stores/view'
import { PlaceIcon } from './place'
import { placeAgo, placeTitle } from './place-title'

/** A row of the history: a place Back or Forward reaches, or the one showing now. */
interface Entry {
  key: string
  place: HistoryPlace
  title: string
  /** How to get there; none for the place showing now. */
  to: { direction: 'back' | 'forward'; step: Step } | null
}

/**
 * Every place of the history, newest first: the places Forward reaches, the one showing now, then
 * those Back reaches. Each opens its place; typing narrows the list.
 */
export function HistoryDialog() {
  const { t } = useTranslation('shell')
  const open = useHistoryDialog((s) => s.open)
  return (
    <Dialog open={open} onOpenChange={showHistory}>
      <DialogContent className="flex max-h-[min(600px,85svh)] flex-col gap-3 sm:max-w-[440px]">
        <DialogTitle>{t('history.title')}</DialogTitle>
        <HistoryList />
      </DialogContent>
    </Dialog>
  )
}

function HistoryList() {
  const { t } = useTranslation('shell')
  const history = useViewStore((s) => s.history)
  const [query, setQuery] = useState('')
  const entries = useMemo(() => {
    const forward = historyPlaces(history, 'forward').reverse()
    const back = historyPlaces(history, 'back')
    const now = placeOf(useViewStore.getState())
    const row = (direction: 'back' | 'forward', step: Step, i: number): Entry => ({
      key: `${direction}-${i}`,
      place: step.place,
      title: placeTitle(step.place),
      to: { direction, step },
    })
    return [
      ...forward.map((step, i) => row('forward', step, i)),
      { key: 'now', place: now, title: placeTitle(now), to: null },
      ...back.map((step, i) => row('back', step, i)),
    ]
  }, [history])
  const now = useNow()

  const open = (entry: Entry | null) => {
    if (!entry) return
    if (entry.to) goToPlace(entry.to.direction, entry.to.step)
    showHistory(false)
  }

  return (
    <Combobox<Entry>
      inline
      open
      autoHighlight
      items={entries}
      value={null}
      onValueChange={open}
      inputValue={query}
      onInputValueChange={setQuery}
      itemToStringLabel={(entry) => entry.title}
    >
      <ComboboxInput showTrigger={false} placeholder={t('history.search')} />
      <ComboboxEmpty className="flex justify-center py-6 text-tertiary empty:hidden">
        {t('history.noMatch', { query })}
      </ComboboxEmpty>
      <ComboboxList
        aria-label={t('history.title')}
        className="-mx-1 max-h-[min(440px,60svh)] p-0 data-empty:hidden"
      >
        {(entry: Entry) => (
          <ComboboxItem
            key={entry.key}
            value={entry}
            aria-current={entry.to ? undefined : 'page'}
            className="gap-2.25 pr-2 aria-[current=page]:font-medium"
          >
            <PlaceIcon place={entry.place} />
            <span className="min-w-0 flex-1 truncate">{entry.title}</span>
            <span className="shrink-0 pl-4 text-hint text-tertiary tabular">
              {entry.to ? placeAgo(entry.to.step.at, now) : t('history.current')}
            </span>
          </ComboboxItem>
        )}
      </ComboboxList>
    </Combobox>
  )
}
