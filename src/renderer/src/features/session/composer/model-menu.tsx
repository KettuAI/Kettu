import { useMemo, useState } from 'react'
import {
  ArrowDataTransferHorizontalIcon,
  FlashIcon,
  Settings02Icon,
  WorkflowSquare01Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { AgentId, ConfigOption } from '@shared/thread'
import { GradientFloor } from '@renderer/components/affect/gradient-floor'
import {
  ModelPicker,
  type PickerAction,
  type PickerModel,
  type PickerToggle,
} from '@renderer/components/affect/model-picker'
import { ShimmerText } from '@renderer/components/affect/shimmer-loader'
import { Spinner } from '@renderer/components/ui/spinner'
import { FAVORITE_MODELS_ROW, openHostSettingsRow } from '@renderer/features/settings/host-sections'
import { Glyph } from '@renderer/features/shell/glyph'
import { formatShortcut } from '@renderer/lib/platform'
import { optionsOn, useAgentOptionsStore } from '@renderer/stores/agent-options'
import { useOverlayPresence } from '@renderer/stores/overlays'
import { useSettingsStore } from '@renderer/stores/settings'
import { EffortDial } from './effort-dial'
import { dialStops, type SelectOption } from './levels'
import {
  MAIN_MODELS,
  defaultUses,
  matchesModel,
  modelLists,
  moreInOrder,
  splitQualifier,
  type ModelRead,
} from './model-list'
import { ModelMark } from './model-mark'
import { modelRating } from './model-ratings'
import { isSelect } from './options'
import { isFast, isUltracode, lockedNow, useSwitchLine } from './switch-options'
import { useSelectPick, useSwitchPicks, type Select } from './use-pick'

// The gradient's stops take their colors from the tokens (see .kettu-ultra-floor in affect.css).
const ULTRA_STOPS: [string, string, string] = ['currentColor', 'currentColor', 'currentColor']

/** Stands in the model menu's place while an agent's options are read for the first time. */
export function ModelMenuLoading() {
  const { t } = useTranslation('composer')
  return (
    <span
      role="status"
      className="inline-flex h-7 animate-in items-center gap-1.5 px-1.5 text-[13px] font-medium text-muted-foreground fade-in fill-mode-backwards delay-200 animation-duration-(--duration-base)"
    >
      <Spinner aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate shimmer">{t('controls.readingModels')}</span>
    </span>
  )
}

/**
 * The model, its effort and the agent's switches on affectUI's Model Picker as it comes: the main
 * models, the agent's favorites when it has any, with their bars, the rest in a More models card
 * beside it, the switches as its switch rows, and effort on a dial or as segments, as Appearance
 * sets.
 */
export function ModelMenu({
  agentId,
  hostId,
  harness,
  config,
  running = false,
  onSelect,
  open,
  onOpenChange,
  outOfCredit = false,
  source,
  onSwitchAgent,
  canSwitchAgent = true,
}: {
  agentId: AgentId
  /** The host the agent is on, null for this computer. */
  hostId: string | null
  /** The harness a switch that follows the agent's setting follows, such as Claude Code. */
  harness: string
  config: readonly ConfigOption[]
  running?: boolean
  onSelect: Select
  open?: boolean
  onOpenChange?: (open: boolean) => void
  outOfCredit?: boolean
  /** The harness and version the models come from. */
  source: string | null
  /** Opens the agent menu in this one's place; without it the menu has no Switch agent. */
  onSwitchAgent?: () => void
  /** Whether the agent can be switched now, which is only between turns. */
  canSwitchAgent?: boolean
}) {
  const { t } = useTranslation('composer')
  const model = config.find((o): o is SelectOption => o.category === 'model' && isSelect(o))
  const effort = config.find(
    (o): o is SelectOption => o.category === 'thought_level' && isSelect(o),
  )
  const switches = config.filter((o) => o.type === 'boolean')
  const [modelValue, pickModel] = useSelectPick(model, onSelect)
  const [effortValue, pickEffort] = useSelectPick(effort, onSelect)
  const flips = useSwitchPicks(onSelect)
  const switchLine = useSwitchLine(harness)
  const effortControl = useSettingsStore((s) => s.settings.appearance.effortControl)
  const choices = model?.choices
  const favorites = useAgentOptionsStore((s) => optionsOn(s, hostId)[agentId]?.pinned)
  const lists = useMemo(
    () => modelLists(choices ?? [], modelValue, { pinned: favorites }),
    [choices, modelValue, favorites],
  )

  const [innerOpen, setInnerOpen] = useState(false)
  const isOpen = open ?? innerOpen
  useOverlayPresence(isOpen, { dismissible: true })
  // While the dial turns, the trigger follows the level at its mark.
  const [preview, setPreview] = useState<string | null>(null)
  const changeOpen = (next: boolean) => {
    setInnerOpen(next)
    onOpenChange?.(next)
  }

  const row = (read: ModelRead): PickerModel => {
    const uses = read.isDefault ? defaultUses(read, lists.all) : null
    // A row's name keeps the model alone, so a long one is not cut; its qualifier leads the line under it.
    const [short, qualifier] = read.isDefault ? [read.name, ''] : splitQualifier(read.name)
    const description =
      [qualifier, uses ? t('controls.defaultUses', { model: uses }) : read.choice.description]
        .filter(Boolean)
        .join(' · ') || undefined
    // The agent's Default takes the bars of the model it runs, when the agent says which.
    const runs = read.choice.modelId
    const rating = read.isDefault
      ? runs
        ? modelRating({ value: runs, name: uses ?? runs })
        : null
      : modelRating(read.choice, read.older)
    return {
      id: read.value,
      name: read.name,
      ...(short !== read.name ? { short } : {}),
      ...(description ? { description } : {}),
      icon: <ModelMark read={read} agentId={agentId} />,
      ...(rating ?? {}),
    }
  }
  // Four rows at most: a chosen model the main list leaves out takes a row after it, or its last
  // row when it has four, which moves to More.
  const shown = lists.extra ? [...lists.main.slice(0, MAIN_MODELS - 1), lists.extra] : lists.main
  const models = shown.map(row)
  const left = lists.all.filter((read) => !shown.includes(read))
  const more = moreInOrder(left).map((read): PickerModel => ({
    id: read.value,
    name: read.name,
    icon: <ModelMark read={read} agentId={agentId} />,
    ...(lists.several && read.provider ? { group: read.provider } : {}),
  }))
  const byValue = new Map(lists.all.map((read) => [read.value, read]))

  const dial = effort ? dialStops(effort, effortValue) : null
  // The trigger shows the level, and none for the agent's Default.
  const efforts =
    dial?.stops.map((s) => ({
      id: s.value,
      label: s.name,
      ...(s.isDefault ? { trigger: false as const } : {}),
    })) ?? []

  const toggles: PickerToggle[] = switches.map((o) => {
    const ultra = isUltracode(o)
    return {
      id: o.id,
      label: o.name,
      icon: <Glyph icon={isFast(o) ? FlashIcon : ultra ? WorkflowSquare01Icon : Settings02Icon} />,
      hint: switchLine(o, running) ?? o.name,
      on: flips.valueOf(o),
      disabled: lockedNow(o, running),
      flag: isFast(o),
      indicator: !isFast(o) && !!o.indicator,
      ...(ultra
        ? {
            onLabel: (
              <ShimmerText className="kettu-ultra-text" duration={2.4}>
                {o.name}
              </ShimmerText>
            ),
            effect: <GradientFloor className="kettu-ultra-floor" colors={ULTRA_STOPS} speed={4} />,
          }
        : {}),
    }
  })

  const actions: PickerAction[] = onSwitchAgent
    ? [
        {
          id: 'switch-agent',
          label: t('switchAgent.menu'),
          icon: <Glyph icon={ArrowDataTransferHorizontalIcon} />,
          disabled: !canSwitchAgent,
          ...(canSwitchAgent ? {} : { hint: t('switchAgent.betweenTurns') }),
          onSelect: onSwitchAgent,
        },
      ]
    : []

  return (
    // The composer focuses its field on a press anywhere else in it, which would close the menu
    // before a model row's click lands.
    <div data-composer-own className="contents">
      <ModelPicker
        className="kettu-model-picker"
        side="top"
        align="end"
        models={models}
        more={more}
        moreFilter={(m, query) => {
          const read = byValue.get(m.id)
          return read ? matchesModel(read, query) : m.name.toLowerCase().includes(query)
        }}
        moreNote={
          <span className="kettu-model-picker__note">
            {source && (
              <span className="min-w-0 truncate">{t('controls.modelsFrom', { source })}</span>
            )}
            <button
              type="button"
              className="kettu-model-picker__customize"
              onClick={() => {
                changeOpen(false)
                openHostSettingsRow(hostId, 'agents', agentId, FAVORITE_MODELS_ROW)
              }}
            >
              {t('controls.customizeModels')}
            </button>
          </span>
        }
        value={lists.chosen?.value}
        onChange={pickModel}
        efforts={efforts}
        effort={preview ?? dial?.shown ?? ''}
        onEffortChange={pickEffort}
        effortLabel={effort?.name || t('controls.effort')}
        effortHint={t('controls.effortHint', { shortcut: formatShortcut('Alt+E') })}
        effortSlot={
          // On segments, the picker draws the levels as a track of its own.
          effort && dial && effortControl === 'dial' ? (
            <EffortDial
              className="kettu-model-picker__dial"
              label={effort.name || t('controls.effort')}
              stops={dial.stops}
              value={dial.shown}
              onChange={pickEffort}
              onPreview={setPreview}
            />
          ) : undefined
        }
        toggles={toggles}
        onToggle={(id, on) => {
          const option = switches.find((o) => o.id === id)
          if (option) flips.pick(option, on)
        }}
        actions={actions}
        open={isOpen}
        onOpenChange={changeOpen}
        triggerLead={outOfCredit ? <span aria-hidden className="kettu-model-warn" /> : undefined}
        triggerLabel={outOfCredit ? t('controls.modelOutOfCredit') : undefined}
        labels={{
          model: t('controls.model'),
          settings: t('controls.modelSettings'),
          speed: t('controls.speed'),
          quality: t('controls.quality'),
          cost: t('controls.cost'),
          varies: t('controls.varies'),
          moreModels: t('controls.moreModels'),
          searchModels: t('controls.searchModels'),
          noModels: t('controls.noModels'),
          noMatch: t('controls.noModelMatch'),
          choose: model ? t('controls.chooseModel') : t('controls.options'),
        }}
      />
    </div>
  )
}
