import { useEffect, useMemo, useState } from 'react'
import { DragDropVerticalIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { MAX_PINNED_MODELS, type AgentStatus } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { Icon } from '@renderer/components/affect/app-shell'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import {
  modelLists,
  splitQualifier,
  type ModelRead,
} from '@renderer/features/session/composer/model-list'
import { ModelMark } from '@renderer/features/session/composer/model-mark'
import { isSelect } from '@renderer/features/session/composer/options'
import { SortableGroup, SortableList } from '@renderer/features/sidebar/sortable-list'
import { errorMessage } from '@renderer/lib/host'
import { useHostHas } from '@renderer/lib/host-features'
import {
  optionsLoaded,
  optionsOn,
  readHostAgentOptions,
  useAgentOptionsStore,
} from '@renderer/stores/agent-options'
import { useHostScope } from '@renderer/stores/host-scope'
import { SetButton, SettingSwitch } from './controls'
import { FAVORITE_MODELS_ROW } from './host-sections'
import { GroupLabel, RowGroup, RowShell } from './rows'

/**
 * An agent's favorite models, which lead its model menu's first page in the order dragged here:
 * every model it offers with a switch, the favorites first. Shown once its models are known, on
 * a host that sets them in order.
 */
export function FavoriteModelsGroup({ status }: { status: AgentStatus }) {
  const { t } = useTranslation('settings')
  const { hostId, request } = useHostScope()
  const settable = useHostHas('pinnedModels') === true
  const entry = useAgentOptionsStore((s) => optionsOn(s, hostId)[status.id])
  const loaded = useAgentOptionsStore((s) => optionsLoaded(s, hostId))
  // Another host's options are read when a connection to it opens; Settings may come before.
  useEffect(() => {
    if (hostId === null || loaded) return
    readHostAgentOptions(hostId).catch((e: unknown) =>
      console.warn(`Could not read the agents' models: ${errorMessage(e)}`),
    )
  }, [hostId, loaded])
  const stored = entry?.pinned
  // What was last sent shows until the host's next word on the agent's options replaces it.
  const [sent, setSent] = useState<{ over: readonly string[] | undefined; next: string[] } | null>(
    null,
  )
  const [error, setError] = useState<string | null>(null)
  const pinned = sent && sent.over === stored ? sent.next : stored
  const choices = entry?.config.find((o) => o.category === 'model' && isSelect(o))?.choices
  const lists = useMemo(
    () => (choices?.length ? modelLists(choices, undefined, { pinned }) : null),
    [choices, pinned],
  )
  if (!settable || !lists || lists.all.length === 0) return null

  const byValue = new Map(lists.all.map((read) => [read.value, read]))
  // A favorite the agent no longer offers is skipped, and dropped once the list is saved again.
  const favorites = (pinned ?? []).flatMap((v) => byValue.get(v) ?? []).slice(0, MAX_PINNED_MODELS)
  const others = lists.all.filter((read) => !favorites.includes(read))
  const full = favorites.length >= MAX_PINNED_MODELS
  const save = (next: string[]) => {
    setError(null)
    setSent({ over: stored, next })
    request('agents.setPinnedModels', { agentId: status.id, models: next }).catch((e: unknown) => {
      setSent(null)
      setError(errorMessage(e))
    })
  }
  const values = favorites.map((read) => read.value)
  const move = (from: number, to: number) => {
    const next = [...values]
    const [value] = next.splice(from, 1)
    if (value === undefined) return
    next.splice(to, 0, value)
    save(next)
  }
  const name = t('agents.favorites.name')
  return (
    <section className="k-group" aria-label={name}>
      <div data-setting-row={FAVORITE_MODELS_ROW}>
        <GroupLabel
          group={{
            id: FAVORITE_MODELS_ROW,
            label: name,
            description: t('agents.favorites.description'),
            ...(favorites.length > 0 && { count: favorites.length }),
            actions: (
              <SetButton variant="ghost" disabled={favorites.length === 0} onClick={() => save([])}>
                {t('agents.favorites.reset')}
              </SetButton>
            ),
          }}
        />
      </div>
      <RowGroup>
        {favorites.length > 0 && (
          <SortableList className="k-sort-rows" onMove={move}>
            {favorites.map((read, index) => (
              <SortableGroup
                key={read.value}
                id={read.value}
                index={index}
                disabled={false}
                className="k-sort-row"
              >
                {(handleRef) => (
                  <RowShell>
                    <ModelLine
                      read={read}
                      agentId={status.id}
                      provider={lists.several}
                      on
                      handleRef={handleRef}
                      onChange={() => save(values.filter((v) => v !== read.value))}
                    />
                  </RowShell>
                )}
              </SortableGroup>
            ))}
          </SortableList>
        )}
        {others.map((read) => (
          <RowShell key={read.value}>
            <ModelLine
              read={read}
              agentId={status.id}
              provider={lists.several}
              on={false}
              full={full}
              onChange={() => save([...values, read.value])}
            />
          </RowShell>
        ))}
      </RowGroup>
      {error && (
        <p role="alert" className="ui-sg-hint k-error" data-wrap="">
          {error}
        </p>
      )}
    </section>
  )
}

/** A model's row: the handle of a favorite, the model's mark and name, and its switch. */
function ModelLine({
  read,
  agentId,
  provider,
  on,
  full = false,
  handleRef,
  onChange,
}: {
  read: ModelRead
  agentId: AgentId
  /** Whether the agent's models come from several providers, which the row then names. */
  provider: boolean
  on: boolean
  /** Whether the favorites are full, so this one cannot be added. */
  full?: boolean
  handleRef?: (element: Element | null) => void
  onChange: () => void
}) {
  const { t } = useTranslation('settings')
  const move = t('agents.favorites.move', { name: read.name })
  // As the model menu names it: the model, and under it its qualifier or else its provider.
  const [short, qualifier] = read.isDefault ? [read.name, ''] : splitQualifier(read.name)
  const under = qualifier || (provider ? read.provider : '')
  const control = (
    <SettingSwitch label={read.name} checked={on} disabled={full} onChange={onChange} />
  )
  return (
    <div className="ui-sg-row k-sort-line">
      {handleRef ? (
        <button
          ref={handleRef}
          type="button"
          className="k-sort-handle"
          aria-label={move}
          title={move}
        >
          <Icon icon={DragDropVerticalIcon} size={16} />
        </button>
      ) : (
        <span aria-hidden className="k-sort-gap" />
      )}
      <span className="k-sort-icon" aria-hidden>
        <ModelMark read={read} agentId={agentId} />
      </span>
      <span className="ui-sg-label">
        <b>{short}</b>
        {under && <small>{under}</small>}
      </span>
      <span className="ui-sg-control">
        {full ? (
          <Tooltip>
            {/* A disabled switch gets no pointer events, so a wrapper holds the tooltip. */}
            <TooltipTrigger render={<span className="flex" />}>{control}</TooltipTrigger>
            <TooltipContent>
              {t('agents.favorites.full', { count: MAX_PINNED_MODELS })}
            </TooltipContent>
          </Tooltip>
        ) : (
          control
        )}
      </span>
    </div>
  )
}
