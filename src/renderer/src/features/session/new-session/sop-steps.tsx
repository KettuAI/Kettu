import type { ReactNode } from 'react'
import { ArrowRight02Icon, SparklesIcon, UserIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { PACES, type Pace, type Sop, type SopEntry, type SopStep, type StepPick } from '@shared/sop'
import type { AgentId } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import { Glyph } from '@renderer/features/shell/glyph'
import { cn } from '@renderer/lib/utils'
import { optionsOn, picksOf, useAgentOptionsStore } from '@renderer/stores/agent-options'
import { agentName } from '@renderer/stores/agents'
import { AgentMenu } from './agent-menu'
import { openSopMarketplace } from './open-task'
import { choosePace, pinStep, taskPins, useSopChoice } from './sop-choice'
import {
  listOf,
  localStepName,
  modelOptionId,
  pickNames,
  pickOf,
  pickValues,
  runsSteps,
  stepSource,
} from './sop-picks'

/** Quick, Balanced or Thorough: told to every agent that picks who does a step. */
export function PaceControl({
  value,
  onChange,
  disabled = false,
}: {
  value: Pace
  onChange: (pace: Pace) => void
  disabled?: boolean
}) {
  const { t } = useTranslation('session')
  return (
    <SegmentedControl<Pace>
      aria-label={t('sop.pace')}
      variant="tray"
      size="sm"
      value={value}
      onChange={onChange}
      disabled={disabled}
      options={PACES.map((pace) => ({ value: pace, label: t(`sop.paces.${pace}`) }))}
    />
  )
}

/** Auto's mark and word: the agent that hands off to the step picks it when it starts. */
export function AutoLabel({ size = 13 }: { size?: number }) {
  const { t } = useTranslation('session')
  return (
    <>
      <Glyph icon={SparklesIcon} size={size} className="shrink-0 text-send" />
      <span className="truncate text-foreground">{t('sop.auto')}</span>
    </>
  )
}

/** Who a pick names: the agent's mark, its model and its effort. */
export function PickLabel({
  pick,
  hostId,
  className,
}: {
  pick: StepPick
  hostId: string | null
  className?: string
}) {
  const entry = useAgentOptionsStore((s) => optionsOn(s, hostId)[pick.agentId])
  const names = pickNames(entry, pick)
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <AgentMark agent={pick.agentId} size={13} hostId={hostId} className="shrink-0" />
      <span className="truncate text-foreground">
        {names.model ?? agentName(pick.agentId, hostId)}
      </span>
      {names.effort && <span className="shrink-0 text-secondary">{names.effort}</span>}
    </span>
  )
}

const CHIP =
  'inline-flex h-7.5 min-w-0 max-w-56 items-center gap-1.5 rounded-lg bg-card px-2.25 text-control shadow-outline'

/** A step pinned for this task, or Auto, at its row's end: a menu to pin or go back to Auto. */
function StepPicker({
  step,
  pin,
  hostId,
  onPin,
}: {
  step: SopStep
  pin: StepPick | null
  hostId: string | null
  onPin: (pick: StepPick | null) => void
}) {
  const { t } = useTranslation('session')
  const entry = useAgentOptionsStore((s) => (pin ? optionsOn(s, hostId)[pin.agentId] : undefined))
  const values = pin ? pickValues(entry, pin) : undefined
  return (
    <AgentMenu
      agentId={pin?.agentId ?? null}
      values={values}
      hostId={hostId}
      triggerClassName={cn(CHIP, 'max-w-64 hover:bg-hover')}
      only={runsSteps}
      emptyLabel={<AutoLabel />}
      action={
        pin
          ? {
              label: t('sop.backToAuto'),
              icon: <Glyph icon={SparklesIcon} size={14} className="text-send" />,
              onSelect: () => onPin(null),
            }
          : null
      }
      onChoose={(agentId, model) => {
        const state = useAgentOptionsStore.getState()
        const own = optionsOn(state, hostId)[agentId]
        const seed =
          pin?.agentId === agentId
            ? pickValues(own, pin)
            : { ...(picksOf(state, hostId, agentId) ?? {}) }
        const modelId = modelOptionId(own)
        if (modelId) {
          if (model === null) delete seed[modelId]
          else seed[modelId] = model
        }
        onPin(own ? pickOf(own, agentId, seed) : { agentId, model, effort: null })
      }}
      onValues={(optionId, value) => {
        if (!pin) return
        const own = optionsOn(useAgentOptionsStore.getState(), hostId)[pin.agentId]
        onPin(pickOf(own, pin.agentId, { ...pickValues(own, pin), [optionId]: value }))
      }}
      label={t('sop.whoDoes', { step: step.name })}
    />
  )
}

/**
 * One row per step of the SOP: its number and name, how its agent is chosen with its hint and
 * what it reviews, and at its end who does it: `first` for the first step, a pin of the SOP as it
 * is, the person as You, and the rest Auto or pinned for this task with `onPin`.
 */
export function StepRows({
  sop,
  sopPins,
  taskPins,
  hostId,
  first,
  onPin,
  className,
}: {
  sop: Sop
  sopPins: Record<string, StepPick>
  taskPins: Record<string, StepPick>
  hostId: string | null
  first: ReactNode
  onPin: (stepId: string, pick: StepPick | null) => void
  className?: string
}) {
  const { t } = useTranslation('session')
  return (
    <ol className={cn('flex flex-col', className)}>
      {sop.steps.map((step, index) => {
        const source = stepSource(step, index, sopPins, taskPins)
        const reviews = step.reviewOf.map((id) => localStepName(sop, id))
        const name = localStepName(sop, step.id)
        return (
          <li
            key={step.id}
            className="grid min-h-11 grid-cols-[1.25rem_minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-2.5 py-1.5 pr-3 pl-4 text-ui text-primary not-last:shadow-[inset_0_-0.5px_0_var(--color-border-soft)]"
          >
            <span className="text-meta text-tertiary tabular-nums">{index + 1}</span>
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate" title={name}>
                {name}
              </span>
              {step.youReview && (
                <span className="shrink-0 rounded-md bg-warning-tint px-1.5 text-small leading-4.5 font-medium text-warning">
                  {t('sop.youReview')}
                </span>
              )}
            </span>
            <span className="flex min-w-0 items-center gap-2">
              {source !== 'auto' && (
                <span className="shrink-0 text-meta text-secondary">
                  {t(`sop.source.${source}`)}
                </span>
              )}
              {source !== 'you' && reviews.length > 0 && (
                <span className="max-w-1/2 shrink-0 truncate text-meta text-tertiary">
                  {t('sop.reviews', { steps: listOf(reviews) })}
                </span>
              )}
              {source !== 'you' && step.hint && (
                <span className="truncate text-meta text-tertiary" title={step.hint}>
                  {t('sop.hint', { hint: step.hint })}
                </span>
              )}
            </span>
            <span className="flex min-w-0 justify-end">
              {source === 'first' ? (
                first
              ) : source === 'you' ? (
                <span className={cn(CHIP, 'shadow-none bg-transparent text-secondary')}>
                  <Glyph icon={UserIcon} size={13} className="shrink-0" />
                  {t('sop.you')}
                </span>
              ) : source === 'pinned' ? (
                <span className={CHIP} title={t('sop.pinnedHint')}>
                  <PickLabel pick={sopPins[step.id]!} hostId={hostId} />
                </span>
              ) : (
                <StepPicker
                  step={step}
                  pin={taskPins[step.id] ?? null}
                  hostId={hostId}
                  onPin={(pick) => onPin(step.id, pick)}
                />
              )}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** The steps in order on one line, each with who does it: an agent's mark, Auto's, or the person. */
export function WhoChain({
  sop,
  sopPins,
  taskPins,
  firstAgentId,
  hostId,
  trailing,
}: {
  sop: Sop
  sopPins: Record<string, StepPick>
  taskPins: Record<string, StepPick>
  firstAgentId: AgentId | null
  hostId: string | null
  trailing?: ReactNode
}) {
  const { t } = useTranslation('session')
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-ui text-primary">
      {sop.steps.map((step, index) => {
        const source = stepSource(step, index, sopPins, taskPins)
        const agentId =
          source === 'first'
            ? firstAgentId
            : source === 'task'
              ? taskPins[step.id]!.agentId
              : source === 'pinned'
                ? sopPins[step.id]!.agentId
                : null
        return (
          <span key={step.id} className="inline-flex items-center gap-1.5">
            {index > 0 && (
              <Glyph icon={ArrowRight02Icon} size={12} className="mr-0.5 text-tertiary" />
            )}
            {source === 'you' ? (
              <Glyph icon={UserIcon} size={12} className="text-icon" />
            ) : agentId ? (
              <AgentMark agent={agentId} size={12} hostId={hostId} />
            ) : (
              <Glyph icon={SparklesIcon} size={12} className="text-send" />
            )}
            {localStepName(sop, step.id)}
            <span className="sr-only">
              {source === 'you'
                ? t('sop.you')
                : agentId
                  ? agentName(agentId, hostId)
                  : t('sop.auto')}
            </span>
          </span>
        )
      })}
      {trailing}
    </p>
  )
}

/**
 * New session's "Who does each step" with an SOP chosen, under the composer: Pace at its top
 * right, then a row per step, `first` being the tray's agent; picks here count for this task only.
 */
export function TaskStepsCard({
  entry,
  hostId,
  first,
}: {
  entry: SopEntry & { sop: Sop }
  hostId: string | null
  first: ReactNode
}) {
  const { t } = useTranslation('session')
  const pace = useSopChoice((s) => s.pace)
  const pins = useSopChoice((s) => taskPins(s, entry.id))
  return (
    <section
      aria-labelledby="new-task-steps"
      className="mt-4.5 w-full max-w-160 shrink-0 overflow-hidden rounded-card bg-card shadow-card animate-in fade-in slide-in-from-bottom-1 animation-duration-(--duration-slow) ease-out-quint"
    >
      <header className="flex items-center justify-between gap-3 px-4 py-3 shadow-[inset_0_-0.5px_0_var(--color-border-soft)]">
        <span className="flex min-w-0 flex-col gap-0.5">
          <h2 id="new-task-steps" className="text-ui font-medium text-primary">
            {t('sop.whoDoesEach')}
          </h2>
          <span className="text-meta text-secondary">{t('sop.autoExplained')}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-meta text-secondary">
          {t('sop.pace')}
          <PaceControl value={pace} onChange={choosePace} />
        </span>
      </header>
      <StepRows
        sop={entry.sop}
        sopPins={entry.pins}
        taskPins={pins}
        hostId={hostId}
        first={first}
        onPin={(stepId, pick) => pinStep(entry.id, stepId, pick)}
        className="shadow-[inset_0_-0.5px_0_var(--color-border-soft)]"
      />
      <footer className="flex items-center justify-between gap-3 px-4 py-2.5 text-meta text-tertiary">
        <span className="min-w-0">{t('sop.paceExplained')}</span>
        <button
          type="button"
          className="shrink-0 text-meta text-link hover:underline"
          onClick={() => openSopMarketplace(entry.id)}
        >
          {t('sop.pinEveryTask')}
        </button>
      </footer>
    </section>
  )
}
