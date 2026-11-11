// Skills Kettu keeps on the host and hands to the agents it is given to: their rows, the install
// form and their listing.

import { useState, type FormEvent } from 'react'
import {
  Delete02Icon,
  Folder01Icon,
  MoreHorizontalIcon,
  Tick02Icon,
  UserMultiple02Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { CatalogSkill, MarketSkill } from '@shared/marketplace'
import { displayTitle } from '@shared/marketplace'
import { Dropdown, Icon, Popover } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { SettingSwitch } from '@renderer/features/settings/controls'
import { currentLocale } from '@renderer/lib/i18n'
import { useHostScope } from '@renderer/stores/host-scope'
import { busyKey } from '@renderer/stores/marketplace'
import { openMarketplace, type MarketplaceTab } from '@renderer/stores/view'
import { installSkill, removeSkill, setSkillOn, type AgentChoice } from './actions'
import { ConfirmDialog, SkillAgentsDialog } from './dialogs'
import { useAgentName, useBusy, useChoosableAgents, useKeptSkill } from './hooks'
import { AgentPicker } from './install'
import { catalogSkill, itemKey } from './model'
import { ExternalLink, ListingFrame, ListingSkeleton, Missing } from './parts'
import { AddControl, ItemRow, KindTag, OfficialBadge } from './rows'
import { skillSubject } from './tile-art'
import { ItemTile } from './tiles'

export function SkillRow({
  skill,
  tab,
  showKind,
  fresh,
}: {
  skill: CatalogSkill
  tab: MarketplaceTab
  showKind: boolean
  fresh?: boolean
}) {
  const { t } = useTranslation('marketplace')
  const open = () => openMarketplace({ item: itemKey({ kind: 'skill', id: skill.id }), tab })
  const kept = useKeptSkill(skill.id)
  const busy = useBusy(busyKey('skill', skill.id))
  return (
    <ItemRow
      title={displayTitle(skill.name)}
      subject={skillSubject(skill.name)}
      official={skill.official}
      tag={showKind ? <KindTag kind="skill" /> : undefined}
      line={skill.description}
      fresh={fresh}
      onOpen={open}
      end={
        <AddControl
          name={displayTitle(skill.name)}
          label={t('row.add')}
          state={busy ? 'busy' : kept ? 'on' : 'off'}
          onOpen={open}
          form={(close) => <SkillInstallForm skill={skill} onDone={close} />}
        />
      }
    />
  )
}

/** Install: all agents or some; the host copies the skill's files, then Kettu keeps it. */
function SkillInstallForm({ skill, onDone }: { skill: CatalogSkill; onDone: () => void }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const [agents, setAgents] = useState<AgentChoice>('all')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onDone()
    void installSkill(scope, { kind: 'catalog', id: skill.id }, agents, skill.id)
  }
  return (
    <form className="k-mkt-install" onSubmit={submit}>
      <b>{t('install.title', { name: displayTitle(skill.name) })}</b>
      <span>{t('skill.installNote')}</span>
      <div className="k-mkt-install__field">
        <small>{t('install.useIn')}</small>
        <AgentPicker value={agents} onChange={setAgents} label={t('install.useIn')} forSkills />
      </div>
      <Button size="sm" type="submit">
        {t('install.submit')}
      </Button>
    </form>
  )
}

/** Who a skill goes to, as a list of names, or every agent. */
function useAgentsLine(agents: AgentChoice): string {
  const { t } = useTranslation('marketplace')
  const agentName = useAgentName()
  if (agents === 'all') return t('listing.everyAgent')
  return new Intl.ListFormat(currentLocale(), { type: 'conjunction' }).format(
    agents.map((id) => agentName(id)),
  )
}

/** A skill's listing: the catalog's entry, or the skill Kettu keeps, added from elsewhere. */
export function SkillListing({
  id,
  tab,
  back,
}: {
  id: string
  tab: MarketplaceTab
  back: () => void
}) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const { useMarketplaceStore, useSettingsStore } = scope
  const loaded = useMarketplaceStore((s) => s.skills)
  const loading = useMarketplaceStore((s) => s.skillsLoading)
  const kept = useSettingsStore((s) => s.settings.marketplace.skills.find((x) => x.id === id))
  const entry = loaded ? catalogSkill(scope, id) : null
  const allAgents = useChoosableAgents()
  const agentsLine = useAgentsLine(kept?.agents ?? 'all')

  if (!entry && !kept) {
    return (
      <ListingFrame back={back}>
        {loading || !loaded ? <ListingSkeleton /> : <Missing back={back} />}
      </ListingFrame>
    )
  }
  const name = kept?.name ?? entry!.name
  const description = entry?.description ?? kept?.description ?? null
  const publisher = entry?.publisher ?? null
  const official = entry?.official ?? false
  const repository = entry?.repository ?? (kept?.source === 'github' ? kept.origin : null)
  const version = kept?.version ?? entry?.version ?? null
  const marks = kept && kept.agents !== 'all' ? kept.agents : allAgents.map((a) => a.id)
  const related = (loaded?.catalog ?? [])
    .filter((s) => s.id !== id && (publisher ? s.publisher === publisher : true))
    .slice(0, 4)
  const source =
    kept?.source === 'local'
      ? t('skill.source.local')
      : kept?.source === 'github'
        ? t('skill.source.github')
        : (entry?.publisher ?? t('skill.source.catalog'))
  return (
    <ListingFrame back={back} rise>
      <header className="k-mkt-head">
        <ItemTile subject={skillSubject(name)} size="big" />
        <span className="k-mkt-head__title">
          <span className="k-mkt-head__name">
            <h1>{name}</h1>
            <KindTag kind="skill" />
          </span>
          {(publisher || kept?.source === 'local') && (
            <span className="k-mkt-head__pub">
              {publisher ?? t('listing.addedByYou')}
              {official && (
                <>
                  <OfficialBadge />
                  <span className="k-mkt-head__trust" aria-hidden>
                    {t('listing.official')}
                  </span>
                </>
              )}
            </span>
          )}
          {description && <span className="k-mkt-head__line">{description}</span>}
        </span>
        <span className="k-mkt-head__act">
          {kept ? (
            <KeptSkillControls skill={kept} onRemoved={back} />
          ) : (
            entry && <SkillInstallButton skill={entry} />
          )}
        </span>
      </header>

      <div className="k-mkt-facts">
        <span>
          <small>{t('listing.facts.worksWith')}</small>
          <b className="k-mkt-facts__agents">
            {marks.slice(0, 6).map((agent) => (
              <AgentMark key={agent} agent={agent} size={15} />
            ))}
            <span className="k-mkt-facts__text">{agentsLine}</span>
          </b>
        </span>
        <span>
          <small>{t('listing.facts.source')}</small>
          <b>{source}</b>
        </span>
        {version && (
          <span>
            <small>{t('listing.facts.version')}</small>
            <b className="k-mkt-mono">{version.slice(0, 7)}</b>
          </span>
        )}
      </div>

      <div className="k-mkt-body">
        <div className="k-mkt-body__main">
          {description && <p className="k-mkt-about">{description}</p>}
          <p className="k-mkt-section-note">{t('skill.howItWorks')}</p>
        </div>
        <aside className="k-mkt-side">
          <dl>
            {publisher && (
              <>
                <dt>{t('listing.side.publisher')}</dt>
                <dd>
                  {publisher}
                  {official && <OfficialBadge />}
                </dd>
              </>
            )}
            {repository && (
              <>
                <dt>{t('listing.side.repository')}</dt>
                <dd>
                  <ExternalLink href={repository} />
                </dd>
              </>
            )}
            {entry?.path && (
              <>
                <dt>{t('skill.side.path')}</dt>
                <dd className="k-mkt-mono" data-selectable="">
                  {entry.path}
                </dd>
              </>
            )}
            {kept?.source === 'local' && (
              <>
                <dt>{t('skill.side.folder')}</dt>
                <dd className="k-mkt-mono" data-selectable="">
                  <Icon icon={Folder01Icon} size={12} />
                  {kept.origin}
                </dd>
              </>
            )}
          </dl>
        </aside>
      </div>

      {related.length > 0 && (
        <section className="ui-as-int-section">
          <h2 className="ui-as-int-section__title">
            {publisher ? t('listing.relatedFrom', { publisher }) : t('listing.related')}
          </h2>
          <div className="ui-as-int-grid">
            {related.map((s) => (
              <SkillRow key={s.id} skill={s} tab={tab} showKind={false} />
            ))}
          </div>
        </section>
      )}
    </ListingFrame>
  )
}

function SkillInstallButton({ skill }: { skill: CatalogSkill }) {
  const { t } = useTranslation('marketplace')
  const [open, setOpen] = useState(false)
  const busy = useBusy(busyKey('skill', skill.id))
  return (
    <span className="ui-as-anchor">
      <Button loading={busy} aria-expanded={open} onClick={() => !busy && setOpen((o) => !o)}>
        {busy ? t('install.installing') : t('install.submit')}
      </Button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        align="end"
        className="ui-as-menu k-mkt-install-pop"
      >
        <SkillInstallForm skill={skill} onDone={() => setOpen(false)} />
      </Popover>
    </span>
  )
}

/** A kept skill's controls: Installed, its switch, and Choose agents and Remove in a menu. */
export function KeptSkillControls({
  skill,
  onRemoved,
  compact,
}: {
  skill: MarketSkill
  onRemoved?: () => void
  compact?: boolean
}) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const [dialog, setDialog] = useState<'agents' | 'remove' | null>(null)
  return (
    <>
      {!compact && (
        <span className="k-mkt-head__on">
          <Icon icon={Tick02Icon} size={14} />
          {t('listing.installed')}
        </span>
      )}
      <SettingSwitch
        label={t('listing.switch', { name: skill.name })}
        checked={skill.on}
        onChange={(on) => void setSkillOn(scope, skill.id, on)}
      />
      <Dropdown
        align="end"
        items={[
          {
            label: t('listing.chooseAgents'),
            icon: UserMultiple02Icon,
            onSelect: () => setDialog('agents'),
          },
          {
            label: t('skill.remove'),
            icon: Delete02Icon,
            danger: true,
            divider: true,
            onSelect: () => setDialog('remove'),
          },
        ]}
        trigger={({ open, toggle }) => (
          <button
            type="button"
            className="k-mkt-icon-btn"
            aria-label={t('listing.more', { name: skill.name })}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={toggle}
          >
            <Icon icon={MoreHorizontalIcon} size={16} />
          </button>
        )}
      />
      <SkillAgentsDialog
        skill={skill}
        open={dialog === 'agents'}
        onOpenChange={(open) => !open && setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === 'remove'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={t('dialogs.removeSkill.title', { name: skill.name })}
        body={t('dialogs.removeSkill.body')}
        confirm={t('dialogs.removeSkill.confirm')}
        action={async () => {
          await removeSkill(scope, skill.id)
          onRemoved?.()
        }}
      />
    </>
  )
}
