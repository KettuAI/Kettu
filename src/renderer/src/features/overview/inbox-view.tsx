import { useState } from 'react'
import { ArrowDown01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { shortDuration } from '@renderer/lib/format'
import { agentName } from '@renderer/stores/agents'
import { sessionTitle } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import { doneOf, frontStep, type OverviewRow, type OverviewState } from './model'
import { OutputChip, RowMark, RowSub, RowTime, StepMark } from './parts'
import { useRowFacts } from './use-row-facts'

const FOR_YOU: readonly OverviewState[] = ['ready', 'you']
const REST: readonly OverviewState[] = ['running', 'stopped']

/**
 * What is for the user, one at a time: the rows ready to take and those waiting for an answer on
 * the left, the chosen one in full on the right. What runs or stopped folds under them.
 */
export function InboxView({ rows }: { rows: OverviewRow[] }) {
  const { t } = useTranslation('overview')
  const [picked, setPicked] = useState<string | null>(null)
  const [unfolded, setUnfolded] = useState<Record<string, boolean>>({})
  const forYou = rows.filter((row) => FOR_YOU.includes(row.state))
  const chosen = rows.find((row) => row.key === picked) ?? forYou[0] ?? rows[0]
  return (
    <div className="k-ov-inbox">
      <div className="k-ov-inbox__list">
        {FOR_YOU.map((state) => {
          const list = rows.filter((row) => row.state === state)
          if (list.length === 0) return null
          return (
            <section key={state} aria-label={t(`states.${state}`)}>
              <h2 className="k-ov-gh k-ov-gh--bare" data-state={state}>
                <i />
                <b>{t(`states.${state}`)}</b>
                <span>{list.length}</span>
              </h2>
              {list.map((row) => (
                <InboxRow key={row.key} row={row} active={row === chosen} onPick={setPicked} />
              ))}
            </section>
          )
        })}
        {forYou.length === 0 && <p className="k-ov-clear">{t('inbox.clear')}</p>}
        <div className="k-ov-rest">
          {REST.map((state) => {
            const list = rows.filter((row) => row.state === state)
            if (list.length === 0) return null
            const open = unfolded[state] === true
            return (
              <section key={state} aria-label={t(`states.${state}`)}>
                <button
                  type="button"
                  className="k-ov-fold"
                  data-state={state}
                  aria-expanded={open}
                  onClick={() => setUnfolded({ ...unfolded, [state]: !open })}
                >
                  <i />
                  <b>{t(`states.${state}`)}</b>
                  <span>{list.length}</span>
                  <Icon icon={open ? ArrowDown01Icon : ArrowRight01Icon} size={12} />
                </button>
                {open &&
                  list.map((row) => (
                    <InboxRow key={row.key} row={row} active={row === chosen} onPick={setPicked} />
                  ))}
              </section>
            )
          })}
        </div>
      </div>
      {chosen && <Detail key={chosen.key} row={chosen} />}
    </div>
  )
}

function InboxRow({
  row,
  active,
  onPick,
}: {
  row: OverviewRow
  active: boolean
  onPick: (key: string) => void
}) {
  const { t } = useTranslation('overview')
  const facts = useRowFacts(row)
  const front = frontStep(facts.steps)
  return (
    <button
      type="button"
      className="k-ov-ir"
      data-active={active || undefined}
      aria-current={active || undefined}
      onClick={() => onPick(row.key)}
    >
      <span className="k-ov-mark">
        <RowMark row={row} />
      </span>
      <span className="k-ov-name">
        <b>{facts.title}</b>
        <small>
          {facts.steps
            ? doneOf(facts.steps) + t('separator') + (front?.name ?? t('allDone'))
            : facts.now}
        </small>
      </span>
      <RowTime row={row} facts={facts} />
    </button>
  )
}

/** One row in full: what it says now, what it made, every step, and the way into it. */
function Detail({ row }: { row: OverviewRow }) {
  const { t } = useTranslation('overview')
  const facts = useRowFacts(row)
  const kids = row.kind === 'session' ? row.node.children : []
  return (
    <article className="ui-sg-card k-ov-detail" aria-label={facts.title}>
      <div className="k-ov-detail__body">
        <span className="k-ov-verdict" data-state={row.state}>
          <i />
          {t(`states.${row.state}`)}
        </span>
        <h2>
          <RowMark row={row} size={18} />
          {facts.title}
        </h2>
        <p className="k-ov-detail__sub">
          <RowSub facts={facts} inline />
        </p>
        <p className="k-ov-detail__now" data-state={row.state}>
          {facts.now}
        </p>

        {facts.outputs.length > 0 && (
          <>
            <h3>{t('detail.outputs')}</h3>
            <div className="k-ov-takes">
              {facts.outputs.map((output) => (
                <OutputChip key={output.kind === 'pr' ? output.url : output.id} output={output}>
                  <small>
                    {t(output.kind === 'pr' ? 'detail.pullRequest' : 'detail.artifact')}
                  </small>
                </OutputChip>
              ))}
            </div>
          </>
        )}

        {facts.steps && (
          <>
            <h3>
              {t('columns.steps')} <span>{doneOf(facts.steps)}</span>
            </h3>
            <ol className="k-ov-list">
              {facts.steps.map((step) => (
                <li key={step.id} data-look={step.look}>
                  <StepMark look={step.look} />
                  <span>{step.name}</span>
                  <em>
                    {step.agentId && agentName(step.agentId, row.hostId)}
                    {step.startedAt !== null && step.endedAt !== null && (
                      <span>{shortDuration(step.endedAt - step.startedAt)}</span>
                    )}
                  </em>
                </li>
              ))}
            </ol>
          </>
        )}

        {kids.length > 0 && (
          <>
            <h3>
              {t('detail.subSessions')} <span>{kids.length}</span>
            </h3>
            <ol className="k-ov-list">
              {kids.map((kid) => (
                <li key={kid.summary.id} data-look="done">
                  <AgentMark agent={kid.summary.agentId} size={13} hostId={row.hostId} />
                  <button
                    type="button"
                    onClick={() => openSession(kid.summary.id, kid.summary.projectPath)}
                  >
                    {sessionTitle(kid.summary)}
                  </button>
                  <em>{agentName(kid.summary.agentId, row.hostId)}</em>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
      <footer className="k-ov-detail__foot">
        <Button size="md" onClick={facts.open}>
          {t(row.kind === 'task' ? 'detail.openTask' : 'detail.openSession')}
        </Button>
      </footer>
    </article>
  )
}
