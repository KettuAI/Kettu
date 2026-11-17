import { DashboardSpeed02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import {
  SPEED_RECENT,
  tokensPerSecond,
  type OutputSpeed,
  type SpeedTotals,
} from '@shared/output-speed'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Glyph } from '@renderer/features/shell/glyph'
import { exactCount, measure } from '@renderer/lib/format'

/**
 * How fast the model writes, on the composer's tray: the latest timed request's tokens a second,
 * marked approximate when it was timed from sending the request. It opens the latest readings, the
 * first token and the turn's and session's averages. Absent until a request is timed.
 */
export function SpeedButton({ speed }: { speed: OutputSpeed | undefined }) {
  const { t } = useTranslation('composer')
  if (!speed) return null
  const rate = measure(tokensPerSecond(speed.last.tokens, speed.last.ms))
  const approx = speed.last.approx
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={t(approx ? 'usage.speed.buttonApprox' : 'usage.speed.button', { rate })}
            className="ui-as-tray-link kettu-tray-link--meter kettu-tray-link--speed"
          />
        }
      >
        <Glyph icon={DashboardSpeed02Icon} size={14} />
        <span className="tabular">
          {t(approx ? 'usage.speed.rateApprox' : 'usage.speed.rate', { rate })}
        </span>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className="kettu-pop w-70">
        <SpeedPart speed={speed} />
      </PopoverContent>
    </Popover>
  )
}

function SpeedPart({ speed }: { speed: OutputSpeed }) {
  const { t } = useTranslation('composer')
  const { last, recent } = speed
  const peak = Math.max(...recent.map((reading) => reading.rate))
  const average = (totals: SpeedTotals) =>
    t(totals.approx > 0 ? 'usage.speed.averageApprox' : 'usage.speed.average', {
      rate: measure(tokensPerSecond(totals.tokens, totals.ms)),
      count: totals.requests,
    })
  return (
    <div className="kettu-cache kettu-speed">
      <b>{t('usage.speed.title')}</b>
      <span className="kettu-speed__big tabular">
        <strong>
          {last.approx && t('usage.speed.about')}
          {measure(tokensPerSecond(last.tokens, last.ms))}
        </strong>{' '}
        {t('usage.speed.unit')}
      </span>
      <span className="kettu-cache__line tabular">
        {t(last.approx ? 'usage.speed.lastRequestSent' : 'usage.speed.lastRequest', {
          tokens: exactCount(last.tokens),
          seconds: measure(last.ms / 1000),
        })}
      </span>
      <span
        className="kettu-speed__bars"
        style={{ gridTemplateColumns: `repeat(${SPEED_RECENT}, 1fr)` }}
        aria-hidden
      >
        {recent.map((reading, i) => (
          <i
            key={i}
            data-on={i === recent.length - 1 || undefined}
            data-approx={reading.approx || undefined}
            style={{ height: `${Math.max(12, (reading.rate / peak) * 100)}%` }}
          />
        ))}
      </span>
      <span className="kettu-speed__caption">
        {t('usage.speed.recent', { count: recent.length })}
      </span>
      <dl className="kettu-speed__rows tabular">
        {last.firstTokenMs !== null && (
          <>
            <dt>{t('usage.speed.firstToken')}</dt>
            <dd>{t('usage.speed.seconds', { seconds: measure(last.firstTokenMs / 1000) })}</dd>
          </>
        )}
        <dt>{t('usage.speed.turn')}</dt>
        <dd>{average(speed.turn)}</dd>
        <dt>{t('usage.speed.session')}</dt>
        <dd>{average(speed.session)}</dd>
      </dl>
      <span className="kettu-cache__note">{t('usage.speed.explain')}</span>
    </div>
  )
}
