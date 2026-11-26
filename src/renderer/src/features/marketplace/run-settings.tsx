import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RadioGroup, RadioGroupTile } from '@renderer/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { useHostScope } from '@renderer/stores/host-scope'
import {
  MCP_RUN_MODES,
  runOf,
  type MarketServer,
  type McpRun,
  type McpRunMode,
} from '@shared/marketplace'
import { setServerRun } from './actions'

const IDLE_MINUTES = [5, 10, 30, 60, 240] as const
const START_SECONDS = [15, 30, 60, 120, 300] as const

/** The choices with the one in effect among them, so a value set elsewhere still shows. */
function withCurrent(choices: readonly number[], current: number): number[] {
  return [...new Set([...choices, current])].sort((a, b) => a - b)
}

/**
 * How Kettu runs a kept server: where a command's process is shared, or that each agent runs it
 * itself; how long an unused process lives; how long the server has to start. A remote server only
 * has the last.
 */
export function RunSettings({ server }: { server: MarketServer }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const run = runOf(server)
  const command = server.spec.type === 'stdio'
  const [saving, setSaving] = useState(false)
  const change = (next: McpRun) => {
    setSaving(true)
    // A failed change says so in a toast of its own.
    void setServerRun(scope, server.id, next).finally(() => setSaving(false))
  }
  const byAgent = run.mode === 'agent'
  return (
    <section className="k-mkt-run">
      <h3>{t('run.title')}</h3>
      {command && (
        <RadioGroup
          aria-label={t('run.mode')}
          value={run.mode}
          disabled={saving}
          onValueChange={(mode) => change({ ...server.run, mode: mode as McpRunMode })}
          className="kettu-sd__choices"
        >
          {MCP_RUN_MODES.map((mode) => (
            <RadioGroupTile key={mode} value={mode} className="kettu-sd__tile">
              <span className="ui-sg-label">
                <b className="k-row-title">{t(`run.modes.${mode}.title`)}</b>
                <small>{t(`run.modes.${mode}.line`)}</small>
              </span>
            </RadioGroupTile>
          ))}
        </RadioGroup>
      )}
      <div className="k-mkt-run__times">
        {command && (
          <TimeChoice
            label={t('run.idle')}
            value={run.idleMinutes}
            choices={withCurrent(IDLE_MINUTES, run.idleMinutes)}
            format={(minutes) =>
              minutes >= 60
                ? t('run.hours', { count: minutes / 60 })
                : t('run.minutes', { count: minutes })
            }
            disabled={saving || byAgent}
            onChange={(idleMinutes) => change({ ...server.run, idleMinutes })}
          />
        )}
        <TimeChoice
          label={t('run.start')}
          value={run.startSeconds}
          choices={withCurrent(START_SECONDS, run.startSeconds)}
          format={(seconds) =>
            seconds >= 60
              ? t('run.minutes', { count: seconds / 60 })
              : t('run.seconds', { count: seconds })
          }
          disabled={saving || byAgent}
          onChange={(startSeconds) => change({ ...server.run, startSeconds })}
        />
      </div>
    </section>
  )
}

function TimeChoice({
  label,
  value,
  choices,
  format,
  disabled,
  onChange,
}: {
  label: string
  value: number
  choices: number[]
  format(value: number): string
  disabled: boolean
  onChange(value: number): void
}) {
  return (
    <label className="k-mkt-run__time">
      <span>{label}</span>
      <Select
        value={String(value)}
        items={choices.map((choice) => ({ value: String(choice), label: format(choice) }))}
        disabled={disabled}
        onValueChange={(next) => {
          if (next !== null && Number(next) !== value) onChange(Number(next))
        }}
      >
        <SelectTrigger aria-label={label} className="ui-ss-select k-select">
          <SelectValue>{(current: string | null) => format(Number(current ?? value))}</SelectValue>
        </SelectTrigger>
        <SelectContent align="start">
          <SelectGroup>
            {choices.map((choice) => (
              <SelectItem key={choice} value={String(choice)}>
                {format(choice)}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </label>
  )
}
