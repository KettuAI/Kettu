// Create / Edit Bot page:
// - Starter templates in creation mode (Dev Manager / PR Reviewer / CI On-Call)
// - 4 configuration sections: Identity & MCP Harness, Computers x Projects matrix, Permissions & Limits, ROLE.md

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { ArrowLeft01Icon, ComputerIcon, LaptopIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import {
  BOT_EXAMPLES,
  DEFAULT_BOT_LIMITS,
  slugifyBotHandle,
  type BotAvatar as BotAvatarSpec,
  type BotExampleId,
  type BotTargetRef,
} from '@shared/bots'
import type { AgentStatus } from '@shared/agent-host'
import { TIME_LIMITS, type PermissionScope, type TimeLimitMinutes } from '@shared/routines'
import type { AgentId } from '@shared/agents'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { toast } from '@renderer/components/ui/toast'
import { HostIcon } from '@renderer/features/settings/remote-parts'
import { Glyph } from '@renderer/features/shell/glyph'
import { errorMessage } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { useAgentsStore } from '@renderer/stores/agents'
import { useBotsStore } from '@renderer/stores/bots'
import { openBot, openNewSession } from '@renderer/stores/view'
import { AvatarPicker, type PendingAvatarUpload } from './avatar-picker'
import { BotAvatar } from './bot-avatar'

function targetKey(t: BotTargetRef): string {
  return `${t.hostId ?? 'local'}::${t.projectPath}`
}

export default function BotEditorPage({
  botId,
  example,
}: {
  botId: string | null
  example?: BotExampleId | null
}) {
  const { t } = useTranslation('bots')
  const existing = useBotsStore((s) => (botId ? s.byId[botId] : undefined))
  const targets = useBotsStore((s) => s.targets)
  const refreshTargets = useBotsStore((s) => s.refreshTargets)
  const createBot = useBotsStore((s) => s.create)
  const updateBot = useBotsStore((s) => s.update)
  const uploadAvatar = useBotsStore((s) => s.uploadAvatar)
  const agentsMap = useAgentsStore((s) => s.byId)

  // List every enabled local Harness that supports HTTP MCP (never locked to a single vendor).
  const availableAgents = useMemo(
    () =>
      Object.values(agentsMap).filter(
        (a): a is AgentStatus =>
          a !== undefined && !a.disabled && !a.uninstalled && a.capabilities.mcpHttp !== false,
      ),
    [agentsMap],
  )

  const initialExample = example ? BOT_EXAMPLES.find((e) => e.id === example) : undefined
  const defaultAgentId: AgentId =
    existing?.agentId ?? availableAgents[0]?.id ?? ('claude-code' as AgentId)

  const [name, setName] = useState(
    existing?.name ?? (initialExample ? t(`examples.${initialExample.id}.name`) : ''),
  )
  const [handle, setHandle] = useState(existing?.handle ?? initialExample?.defaultHandle ?? '')
  const [handleEdited, setHandleEdited] = useState(Boolean(existing || initialExample))
  const [description, setDescription] = useState(
    existing?.description ?? (initialExample ? t(`examples.${initialExample.id}.description`) : ''),
  )
  const [avatar, setAvatar] = useState<BotAvatarSpec>(
    existing?.avatar ??
      initialExample?.avatar ?? { kind: 'preset', preset: 'architect', palette: 'fox' },
  )
  const [pendingUpload, setPendingUpload] = useState<PendingAvatarUpload | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<AgentId | null>(existing?.agentId ?? null)
  const agentId: AgentId =
    selectedAgentId && (existing || availableAgents.some((a) => a.id === selectedAgentId))
      ? selectedAgentId
      : defaultAgentId
  const [model, setModel] = useState(existing?.model ?? '')
  const [selectedTargets, setSelectedTargets] = useState<BotTargetRef[]>(existing?.targets ?? [])
  const [scope, setScope] = useState<PermissionScope>(
    existing?.scope ?? initialExample?.scope ?? { level: 'edit', web: true },
  )
  const [maxConcurrent, setMaxConcurrent] = useState(
    existing?.limits.maxConcurrent ??
      initialExample?.limits.maxConcurrent ??
      DEFAULT_BOT_LIMITS.maxConcurrent,
  )
  const [maxDaily, setMaxDaily] = useState(
    existing?.limits.maxDaily ?? initialExample?.limits.maxDaily ?? DEFAULT_BOT_LIMITS.maxDaily,
  )
  const [timeLimitMinutes, setTimeLimitMinutes] = useState<TimeLimitMinutes>(
    existing?.limits.timeLimitMinutes ??
      initialExample?.limits.timeLimitMinutes ??
      DEFAULT_BOT_LIMITS.timeLimitMinutes,
  )
  const [maxUnattendedRounds, setMaxUnattendedRounds] = useState(
    existing?.limits.maxUnattendedRounds ??
      initialExample?.limits.maxUnattendedRounds ??
      DEFAULT_BOT_LIMITS.maxUnattendedRounds,
  )
  const [roleMarkdown, setRoleMarkdown] = useState(
    existing?.roleMarkdown ?? (initialExample ? t(`examples.${initialExample.id}.role`) : ''),
  )
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void refreshTargets()
  }, [refreshTargets])

  const applyExample = (exId: BotExampleId) => {
    const spec = BOT_EXAMPLES.find((e) => e.id === exId)
    if (!spec) return
    setName(t(`examples.${exId}.name`))
    setHandle(spec.defaultHandle)
    setHandleEdited(true)
    setDescription(t(`examples.${exId}.description`))
    setAvatar(spec.avatar)
    setPendingUpload(null)
    setScope(spec.scope)
    setMaxConcurrent(spec.limits.maxConcurrent)
    setMaxDaily(spec.limits.maxDaily)
    setTimeLimitMinutes(spec.limits.timeLimitMinutes)
    setMaxUnattendedRounds(spec.limits.maxUnattendedRounds)
    setRoleMarkdown(t(`examples.${exId}.role`))
  }

  const toggleTarget = (ref: BotTargetRef) => {
    const key = targetKey(ref)
    setSelectedTargets((prev) =>
      prev.some((item) => targetKey(item) === key)
        ? prev.filter((item) => targetKey(item) !== key)
        : [...prev, ref],
    )
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    const finalHandle = (handle.trim() || slugifyBotHandle(name)).toLowerCase()
    const payloadAvatar =
      avatar.kind === 'image' && pendingUpload
        ? { kind: 'preset' as const, preset: 'architect' as const, palette: 'fox' as const }
        : avatar
    setSaving(true)
    try {
      let savedBot = existing
        ? await updateBot(existing.id, {
            name: name.trim(),
            handle: finalHandle,
            description: description.trim(),
            avatar: payloadAvatar,
            agentId,
            model: model.trim() || null,
            targets: selectedTargets,
            scope,
            limits: { maxConcurrent, maxDaily, timeLimitMinutes, maxUnattendedRounds },
            roleMarkdown,
          })
        : await createBot({
            name: name.trim(),
            handle: finalHandle,
            description: description.trim(),
            avatar: payloadAvatar,
            agentId,
            model: model.trim() || null,
            targets: selectedTargets,
            scope,
            limits: { maxConcurrent, maxDaily, timeLimitMinutes, maxUnattendedRounds },
            roleMarkdown,
          })
      if (pendingUpload) {
        savedBot = await uploadAvatar(savedBot.id, pendingUpload.mimeType, pendingUpload.dataBase64)
      }
      openBot(savedBot.id)
    } catch (error) {
      toast(errorMessage(error), undefined, { tone: 'warning' })
    } finally {
      setSaving(false)
    }
  }

  const selectedKeys = useMemo(() => new Set(selectedTargets.map(targetKey)), [selectedTargets])
  const hasRemoteHosts = targets.some((tItem) => !tItem.self)

  return (
    <div className="flex h-full flex-col overflow-hidden bg-(--bg-app)">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-(--border-subtle) px-6 py-3.5">
        <div className="flex items-center gap-2.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => (existing ? openBot(existing.id) : openNewSession(null, null))}
          >
            <Glyph icon={ArrowLeft01Icon} size={16} />
          </Button>
          <div>
            <h1 className="text-base font-semibold text-primary">
              {existing ? t('editBot') : t('newBot')}
            </h1>
            <p className="text-caption text-tertiary">{t('editor.subtitle')}</p>
          </div>
        </div>
      </header>

      <form onSubmit={(e) => void handleSubmit(e)} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-6 py-6">
          {/* Starter examples in create mode */}
          {!existing && (
            <section className="flex flex-col gap-2">
              <h2 className="text-caption font-medium text-tertiary">
                {t('editor.examplesTitle')}
              </h2>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                {BOT_EXAMPLES.map((spec) => (
                  <button
                    key={spec.id}
                    type="button"
                    onClick={() => applyExample(spec.id)}
                    className="flex flex-col gap-2 rounded-xl border border-(--border-subtle) bg-(--bg-surface) p-3 text-left transition-colors hover:border-(--border-strong) hover:bg-(--bg-hover)"
                  >
                    <div className="flex items-center gap-2.5">
                      <BotAvatar
                        avatar={spec.avatar}
                        name={t(`examples.${spec.id}.name`)}
                        size={32}
                      />
                      <div className="min-w-0">
                        <div className="truncate text-small font-medium text-primary">
                          {t(`examples.${spec.id}.name`)}
                        </div>
                        <div className="font-mono text-[11px] text-tertiary">
                          @{spec.defaultHandle}
                        </div>
                      </div>
                    </div>
                    <p className="line-clamp-2 text-caption text-secondary">
                      {t(`examples.${spec.id}.description`)}
                    </p>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* 1. Identity & Harness */}
          <section className="flex flex-col gap-4 rounded-2xl border border-(--border-subtle) bg-(--bg-surface) p-5">
            <h2 className="text-small font-semibold text-primary">{t('editor.sectionIdentity')}</h2>

            <AvatarPicker
              value={avatar}
              name={name}
              botId={existing?.id}
              pendingUpload={pendingUpload}
              onChange={setAvatar}
              onUploadReady={setPendingUpload}
            />

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-caption font-medium text-secondary">{t('editor.name')}</span>
                <input
                  type="text"
                  required
                  maxLength={60}
                  value={name}
                  placeholder={t('editor.namePlaceholder')}
                  onChange={(e) => {
                    setName(e.target.value)
                    if (!handleEdited) setHandle(slugifyBotHandle(e.target.value))
                  }}
                  className="h-9 rounded-lg border border-(--border-default) bg-(--bg-app) px-3 text-small text-primary focus:border-(--focus) focus:outline-none"
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="text-caption font-medium text-secondary">
                  {t('editor.handle')}
                </span>
                <div className="relative">
                  <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-mono text-small text-tertiary">
                    @
                  </span>
                  <input
                    type="text"
                    required
                    maxLength={32}
                    value={handle}
                    onChange={(e) => {
                      setHandleEdited(true)
                      setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))
                    }}
                    className="h-9 w-full rounded-lg border border-(--border-default) bg-(--bg-app) pr-3 pl-7 font-mono text-small text-primary focus:border-(--focus) focus:outline-none"
                  />
                </div>
                <span className="text-[11px] text-tertiary">
                  {t('editor.handleHint', { handle: handle || 'bot' })}
                </span>
              </label>
            </div>

            <label className="flex flex-col gap-1.5">
              <span className="text-caption font-medium text-secondary">
                {t('editor.description')}
              </span>
              <input
                type="text"
                maxLength={240}
                value={description}
                placeholder={t('editor.descriptionPlaceholder')}
                onChange={(e) => setDescription(e.target.value)}
                className="h-9 rounded-lg border border-(--border-default) bg-(--bg-app) px-3 text-small text-primary focus:border-(--focus) focus:outline-none"
              />
            </label>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-caption font-medium text-secondary">
                  {t('editor.harness')}
                </span>
                <select
                  value={agentId}
                  onChange={(e) => setSelectedAgentId(e.target.value as AgentId)}
                  className="h-9 rounded-lg border border-(--border-default) bg-(--bg-app) px-2.5 text-small text-primary focus:border-(--focus) focus:outline-none"
                >
                  {availableAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                  {availableAgents.length === 0 && <option value={agentId}>{agentId}</option>}
                </select>
                <span className="text-[11px] text-tertiary">{t('editor.harnessHint')}</span>
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="text-caption font-medium text-secondary">{t('editor.model')}</span>
                <input
                  type="text"
                  value={model}
                  placeholder={t('editor.modelDefault')}
                  onChange={(e) => setModel(e.target.value)}
                  className="h-9 rounded-lg border border-(--border-default) bg-(--bg-app) px-3 text-small text-primary focus:border-(--focus) focus:outline-none"
                />
              </label>
            </div>
          </section>

          {/* 2. Computers x Projects matrix */}
          <section className="flex flex-col gap-3 rounded-2xl border border-(--border-subtle) bg-(--bg-surface) p-5">
            <div>
              <h2 className="text-small font-semibold text-primary">
                {t('editor.sectionTargets')}
              </h2>
              <p className="mt-0.5 text-caption text-tertiary">{t('editor.targetsHint')}</p>
            </div>

            <div className="flex flex-col gap-3">
              {targets.map((hostTarget) => (
                <div
                  key={hostTarget.hostId ?? 'local'}
                  className="rounded-xl border border-(--border-subtle) bg-(--bg-app) p-3"
                >
                  <div className="mb-2 flex items-center gap-2 text-caption font-medium text-primary">
                    {hostTarget.self ? (
                      <Glyph
                        icon={hostTarget.platform === 'darwin' ? LaptopIcon : ComputerIcon}
                        size={14}
                      />
                    ) : (
                      <HostIcon platform={hostTarget.platform} className="size-3.5" />
                    )}
                    <span>{hostTarget.name}</span>
                    <span
                      className={cn(
                        'rounded-full px-1.5 py-0.5 text-[10.5px]',
                        hostTarget.online
                          ? 'bg-(--success-tint) text-(--success)'
                          : 'bg-(--bg-subtle) text-tertiary',
                      )}
                    >
                      {hostTarget.online ? t('work.online') : t('work.offline')}
                    </span>
                  </div>
                  {hostTarget.projects.length === 0 ? (
                    <p className="text-caption text-tertiary">—</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {hostTarget.projects.map((proj) => {
                        const ref: BotTargetRef = {
                          hostId: hostTarget.hostId,
                          projectPath: proj.path,
                          projectName: proj.name,
                        }
                        const checked = selectedKeys.has(targetKey(ref))
                        return (
                          <button
                            key={proj.path}
                            type="button"
                            onClick={() => toggleTarget(ref)}
                            className={cn(
                              'rounded-lg border px-2.5 py-1 text-caption transition-colors',
                              checked
                                ? 'border-(--control-on) bg-(--control-on-tint) font-medium text-primary'
                                : 'border-(--border-default) bg-(--bg-surface) text-secondary hover:border-(--border-strong)',
                            )}
                          >
                            {proj.name}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {!hasRemoteHosts && (
              <p className="text-caption text-tertiary">{t('editor.noPairedHosts')}</p>
            )}
          </section>

          {/* 3. Permissions & Limits */}
          <section className="flex flex-col gap-4 rounded-2xl border border-(--border-subtle) bg-(--bg-surface) p-5">
            <h2 className="text-small font-semibold text-primary">
              {t('editor.sectionPermissions')}
            </h2>

            <div className="flex flex-col gap-2">
              <span className="text-caption font-medium text-secondary">
                {t('editor.scopeLevel')}
              </span>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {(['read', 'edit', 'commands'] as const).map((level) => (
                  <button
                    key={level}
                    type="button"
                    onClick={() => setScope((s) => ({ ...s, level }))}
                    className={cn(
                      'rounded-xl border px-3 py-2 text-left text-caption font-medium transition-colors',
                      scope.level === level
                        ? 'border-(--control-on) bg-(--control-on-tint) text-primary'
                        : 'border-(--border-default) bg-(--bg-app) text-secondary hover:border-(--border-strong)',
                    )}
                  >
                    {t(`editor.scope.${level}`)}
                  </button>
                ))}
              </div>
            </div>

            <label className="flex items-center justify-between gap-3">
              <span className="text-small text-primary">{t('editor.scopeWeb')}</span>
              <Switch
                checked={scope.web}
                onCheckedChange={(web) => setScope((s) => ({ ...s, web }))}
              />
            </label>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <label className="flex flex-col gap-1">
                <span className="text-caption text-secondary">{t('editor.maxConcurrent')}</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={maxConcurrent}
                  onChange={(e) =>
                    setMaxConcurrent(Math.max(1, Math.min(20, Number(e.target.value) || 1)))
                  }
                  className="h-9 rounded-lg border border-(--border-default) bg-(--bg-app) px-2.5 text-small tabular-nums"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-caption text-secondary">{t('editor.maxDaily')}</span>
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={maxDaily}
                  onChange={(e) =>
                    setMaxDaily(Math.max(1, Math.min(500, Number(e.target.value) || 1)))
                  }
                  className="h-9 rounded-lg border border-(--border-default) bg-(--bg-app) px-2.5 text-small tabular-nums"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-caption text-secondary">{t('editor.timeLimit')}</span>
                <select
                  value={timeLimitMinutes}
                  onChange={(e) => setTimeLimitMinutes(Number(e.target.value) as TimeLimitMinutes)}
                  className="h-9 rounded-lg border border-(--border-default) bg-(--bg-app) px-2 text-small tabular-nums"
                >
                  {TIME_LIMITS.map((m) => (
                    <option key={m} value={m}>
                      {m} min
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-caption text-secondary">{t('editor.maxRounds')}</span>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={maxUnattendedRounds}
                  onChange={(e) =>
                    setMaxUnattendedRounds(Math.max(1, Math.min(50, Number(e.target.value) || 1)))
                  }
                  className="h-9 rounded-lg border border-(--border-default) bg-(--bg-app) px-2.5 text-small tabular-nums"
                />
              </label>
            </div>
          </section>

          {/* 4. Role instructions (ROLE.md) */}
          <section className="flex flex-col gap-2 rounded-2xl border border-(--border-subtle) bg-(--bg-surface) p-5">
            <h2 className="text-small font-semibold text-primary">{t('editor.sectionRole')}</h2>
            <p className="text-caption text-tertiary">{t('role.hint')}</p>
            <textarea
              rows={8}
              value={roleMarkdown}
              placeholder={t('role.placeholder')}
              onChange={(e) => setRoleMarkdown(e.target.value)}
              className="resize-y rounded-xl border border-(--border-default) bg-(--bg-app) p-3 font-mono text-caption leading-relaxed text-primary focus:border-(--focus) focus:outline-none"
            />
          </section>

          <div className="flex items-center justify-end gap-2.5 pb-6">
            <Button
              type="button"
              variant="ghost"
              onClick={() => (existing ? openBot(existing.id) : openNewSession(null, null))}
            >
              {t('work.cancel')}
            </Button>
            <Button type="submit" disabled={!name.trim() || saving}>
              {existing ? t('saveChanges') : t('createBot')}
            </Button>
          </div>
        </div>
      </form>
    </div>
  )
}
