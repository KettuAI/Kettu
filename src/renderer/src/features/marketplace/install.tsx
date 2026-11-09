// What Install asks before it runs: the agents that get the server, and a field for each value
// it needs, a password field for a secret. Kettu keeps the server and hands it to those agents
// when their sessions start.

import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { specInputs, type CatalogServer } from '@shared/marketplace'
import type { AgentId } from '@shared/thread'
import { Button } from '@renderer/components/affect/button'
import { TextField } from '@renderer/components/affect/text-field'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import type { AgentChoice } from './actions'
import { useChoosableAgents } from './hooks'
import { takesSkills } from './model'

/**
 * All agents, or some of them: All takes in agents added later; picking an agent narrows the
 * choice to the agents picked, and unpicking the last one goes back to All. For skills, an agent
 * that cannot take them shows why and cannot be picked.
 */
export function AgentPicker({
  value,
  onChange,
  label,
  forSkills = false,
}: {
  value: AgentChoice
  onChange: (value: AgentChoice) => void
  label: string
  forSkills?: boolean
}) {
  const { t } = useTranslation('marketplace')
  const agents = useChoosableAgents()
  const pick = (id: AgentId) => {
    if (value === 'all') return onChange([id])
    const next = value.includes(id) ? value.filter((x) => x !== id) : [...value, id]
    onChange(next.length === 0 ? 'all' : next)
  }
  return (
    <div className="k-mkt-agents" role="group" aria-label={label}>
      <button
        type="button"
        role="checkbox"
        aria-checked={value === 'all'}
        className="k-mkt-agents__agent"
        onClick={() => onChange('all')}
      >
        <span className="k-mkt-agents__all" aria-hidden>
          {agents.slice(0, 4).map((agent) => (
            <AgentMark key={agent.id} agent={agent.id} size={11} dot={null} />
          ))}
        </span>
        {t('install.allAgents')}
      </button>
      {agents.map((agent) => (
        <button
          key={agent.id}
          type="button"
          role="checkbox"
          aria-checked={value !== 'all' && value.includes(agent.id)}
          className="k-mkt-agents__agent"
          disabled={forSkills && !takesSkills(agent.id)}
          onClick={() => pick(agent.id)}
        >
          <AgentMark agent={agent.id} size={13} />
          <span className="k-mkt-agents__name">{agent.name}</span>
          {forSkills && !takesSkills(agent.id) && (
            <span className="k-mkt-agents__note">{t('install.noSkills')}</span>
          )}
        </button>
      ))}
    </div>
  )
}

/** The input's label: its name in mono, marked when it must be filled. */
export function InputLabel({ name, required }: { name: string; required: boolean }) {
  const { t } = useTranslation('marketplace')
  return (
    <span className="k-mkt-input-label">
      <span className="k-mkt-mono">{name}</span>
      {required && <span className="k-mkt-required">{t('install.required')}</span>}
    </span>
  )
}

/** The install form, in the popover of a row's add button or of a listing's Install. */
export function InstallForm({
  server,
  onDone,
}: {
  server: CatalogServer
  onDone: (agents: AgentChoice, values: Record<string, string>) => void
}) {
  const { t } = useTranslation('marketplace')
  const inputs = specInputs(server.spec)
  const [agents, setAgents] = useState<AgentChoice>('all')
  const [values, setValues] = useState<Record<string, string>>({})
  const missing = inputs.some((input) => input.required && !values[input.name]?.trim())
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (missing) return
    const trimmed = Object.fromEntries(
      Object.entries(values).map(([name, value]) => [name, value.trim()]),
    )
    onDone(agents, trimmed)
  }
  return (
    <form className="k-mkt-install" onSubmit={submit}>
      <b>{t('install.title', { name: server.title })}</b>
      <span>{t('install.note')}</span>
      <div className="k-mkt-install__field">
        <small>{t('install.useIn')}</small>
        <AgentPicker value={agents} onChange={setAgents} label={t('install.useIn')} />
      </div>
      {inputs.map((input, i) => (
        <TextField
          key={input.name}
          size="sm"
          type={input.secret ? 'password' : 'text'}
          autoFocus={i === 0}
          autoComplete="off"
          spellCheck={false}
          prefix={input.prefix}
          label={<InputLabel name={input.name} required={input.required} />}
          hint={
            input.description || (input.secret ? t('install.secretHint') : t('install.valueHint'))
          }
          value={values[input.name] ?? ''}
          onChange={(event) => setValues((v) => ({ ...v, [input.name]: event.target.value }))}
        />
      ))}
      <Button size="sm" type="submit" disabled={missing}>
        {t('install.submit')}
      </Button>
    </form>
  )
}
