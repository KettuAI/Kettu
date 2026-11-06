// A routine's permission scope as a card: three levels to choose from, the web switch, and what
// its agent keeps to under the card.

import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { PermissionScope } from '@shared/routines'
import type { AgentId } from '@shared/thread'
import { Row, Toggle } from './kit'

const LEVELS: readonly PermissionScope['level'][] = ['read', 'edit', 'commands']

const CAPTIONS = {
  'claude-code': true,
  codex: true,
  opencode: true,
  pi: true,
} satisfies Partial<Record<AgentId, true>>

function hasCaption(agentId: AgentId): agentId is keyof typeof CAPTIONS {
  return agentId in CAPTIONS
}

export function PermissionField({
  scope,
  agentId,
  onChange,
}: {
  scope: PermissionScope
  agentId: AgentId | null
  onChange: (scope: PermissionScope) => void
}) {
  const { t } = useTranslation('routines')
  const name = useId()
  const caption =
    agentId !== null && hasCaption(agentId) ? t(`permission.caption.${agentId}`) : null
  return (
    <>
      <div className="ui-sg-card" role="radiogroup" aria-label={t('permission.levels')}>
        {LEVELS.map((level) => (
          <label
            key={level}
            className="ui-sg-row k-radio"
            data-on={scope.level === level || undefined}
          >
            <span className="ui-sg-label">
              <b>{t(`permission.level.${level}.name`)}</b>
              <small>{t(`permission.level.${level}.description`)}</small>
            </span>
            <input
              type="radio"
              name={name}
              checked={scope.level === level}
              onChange={() => onChange({ ...scope, level })}
            />
            <span className="k-radio__mark" aria-hidden="true" />
          </label>
        ))}
        <Row title={t('permission.web.name')} note={t('permission.web.description')}>
          <Toggle
            on={scope.web}
            label={t('permission.web.name')}
            onChange={(web) => onChange({ ...scope, web })}
          />
        </Row>
      </div>
      {caption && <p className="ui-sg-hint">{caption}</p>}
    </>
  )
}
