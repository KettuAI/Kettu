// The first run on a fresh install: Welcome, the choice between a Kettu account and self-hosted,
// signing in for the account, and the agents found on this computer. Loaded only while it shows.

import './onboarding.css'
import { useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import {
  Alert02Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  BrowserIcon,
  CheckmarkCircle02Icon,
  CloudIcon,
  ComputerTerminal01Icon,
  Globe02Icon,
  Home01Icon,
  InformationCircleIcon,
  Link01Icon,
  Notification01Icon,
  SecurityCheckIcon,
  SquareLock02Icon,
  UserCircleIcon,
  Wifi01Icon,
} from '@hugeicons/core-free-icons'
import type { AgentStatus } from '@shared/agent-host'
import type { AccountStatus } from '@shared/account'
import type { OnboardingStep } from '@shared/settings'
import sceneAccountDay from '@renderer/assets/onboarding/scene-account-day.webp'
import sceneAccountNight from '@renderer/assets/onboarding/scene-account-night.webp'
import sceneSelfHostedDay from '@renderer/assets/onboarding/scene-self-hosted-day.webp'
import sceneSelfHostedNight from '@renderer/assets/onboarding/scene-self-hosted-night.webp'
import { Icon } from '@renderer/components/affect/app-shell'
import { AgentTile } from '@renderer/components/agents/agent-mark'
import { BrandIcon } from '@renderer/components/brand'
import { Button } from '@renderer/components/ui/button'
import { RingSpinner } from '@renderer/components/ui/spinner'
import { toast } from '@renderer/components/ui/toast'
import { AgentGuide } from '@renderer/features/session/new-session/agent-guide'
import { useGuideStatuses } from '@renderer/features/session/new-session/guide-statuses'
import { agentLine } from '@renderer/features/session/new-session/picker'
import { agentNeed } from '@renderer/features/session/new-session/start-options'
import { SelfHostedMark } from '@renderer/features/settings/cloud-section'
import { Language } from '@renderer/features/settings/sections'
import { errorMessage } from '@renderer/lib/host'
import { hasBand } from '@renderer/lib/platform'
import { cancelSignIn, signIn, useAccountStore } from '@renderer/stores/account'
import { menuAgents, useAgentsStore } from '@renderer/stores/agents'
import { useSettingsStore } from '@renderer/stores/settings'
import { AgentsStage, BrowserStage, CloudDiagram, FoxStage, NoAgentsStage } from './stage'

type Choice = 'account' | 'self-hosted'

// --duration-slow and --ease-out-quart, as the launch cover fades.
const SLOW = 0.3
const EASE = [0.165, 0.84, 0.44, 1] as const
// The blur rise a session's blocks enter with.
const RISE = {
  initial: { opacity: 0, y: 4, filter: 'blur(4px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
  transition: { duration: 0.32, ease: [0.22, 1, 0.36, 1] as const },
}

function save(patch: Parameters<ReturnType<typeof useSettingsStore.getState>['update']>[0]) {
  void useSettingsStore
    .getState()
    .update(patch)
    .catch((error: unknown) => toast(errorMessage(error), undefined, { tone: 'warning' }))
}

export default function Onboarding() {
  const { t } = useTranslation('onboarding')
  const saved = useSettingsStore((s) => s.settings.onboarding.step)
  const cloud = useSettingsStore((s) => s.settings.cloud.enabled)
  const [step, setStep] = useState<OnboardingStep>(saved)
  // An onboarding resumed past the choice keeps the one made; a fresh one has none yet.
  const [choice, setChoice] = useState<Choice | null>(
    saved === 'sign-in' || saved === 'agents' ? (cloud ? 'account' : 'self-hosted') : null,
  )

  const go = (next: OnboardingStep) => {
    setStep(next)
    save({ onboarding: { step: next } })
  }
  const finish = () => save({ onboarding: { done: true } })
  const count = choice === 'self-hosted' ? 3 : 4

  return (
    <motion.div
      className="kob app-region-drag"
      // Windows and Linux draw their window controls over the page's top band.
      data-band={hasBand ? '' : undefined}
      role="dialog"
      aria-modal="true"
      aria-label={t('label')}
      exit={{ opacity: 0 }}
      transition={{ duration: SLOW, ease: EASE }}
    >
      {/* The steps cross: the next rises in while the last fades, so none waits on the other. */}
      <AnimatePresence initial={false}>
        <motion.div
          key={step}
          className="kob-step"
          {...RISE}
          exit={{ opacity: 0, transition: { duration: 0.15 } }}
        >
          {step === 'welcome' && <Welcome onStart={() => go('choose')} />}
          {step === 'choose' && (
            <Choose
              choice={choice}
              onChoose={setChoice}
              onBack={() => go('welcome')}
              onContinue={() => {
                if (!choice) return
                save({ cloud: { enabled: choice === 'account' } })
                go(choice === 'account' ? 'sign-in' : 'agents')
              }}
            />
          )}
          {step === 'sign-in' && (
            <SignIn onBack={() => go('choose')} onNext={() => go('agents')} count={count} />
          )}
          {step === 'agents' && (
            <Agents
              at={count}
              count={count}
              onBack={() => go(choice === 'self-hosted' ? 'choose' : 'sign-in')}
              onFinish={finish}
            />
          )}
        </motion.div>
      </AnimatePresence>
    </motion.div>
  )
}

/** The progress bars of the steps after Welcome, the current one in the control color. */
function Steps({ at, count }: { at: number; count: number }) {
  const { t } = useTranslation('onboarding')
  return (
    <div className="kob-steps" aria-label={t('steps', { at, count })}>
      {Array.from({ length: count }, (_, i) => (
        <i key={i} data-state={i + 1 < at ? 'done' : i + 1 === at ? 'on' : undefined} />
      ))}
      <span aria-hidden>{t('steps', { at, count })}</span>
    </div>
  )
}

/** Content on the left, what it means on the stage at the right. */
function Split({
  head,
  children,
  foot,
  stage,
}: {
  head?: ReactNode
  children: ReactNode
  foot: ReactNode
  stage: ReactNode
}) {
  return (
    <div className="kob-split">
      {/* Before the content: drag regions apply in page order, and the stage's pictures reach
          under the left column, where they would turn its buttons back into the drag region. */}
      <aside className="kob-stage" aria-hidden>
        {stage}
      </aside>
      <section className="kob-left">
        <div className="kob-head">{head}</div>
        <div className="kob-body">{children}</div>
        <footer className="kob-foot">{foot}</footer>
      </section>
    </div>
  )
}

function BackButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation('onboarding')
  return (
    <Button variant="ghost" onClick={onClick}>
      <Icon icon={ArrowLeft01Icon} size={14} />
      {t('back')}
    </Button>
  )
}

// ---- Welcome

function Welcome({ onStart }: { onStart: () => void }) {
  const { t } = useTranslation('onboarding')
  return (
    <Split
      stage={<FoxStage />}
      foot={
        <div className="kob-lang" aria-label={t('welcome.language')}>
          <Language />
        </div>
      }
    >
      <BrandIcon size={48} className="kob-mark" />
      <h1 className="kob-title">{t('welcome.title')}</h1>
      <p className="kob-lead">{t('welcome.lead')}</p>
      <div className="kob-cta">
        <Button size="lg" autoFocus onClick={onStart}>
          {t('welcome.start')}
          <Icon icon={ArrowRight01Icon} size={14} />
        </Button>
      </div>
      <p className="kob-fine">
        <Icon icon={SecurityCheckIcon} size={13} />
        {t('welcome.fine')}
      </p>
    </Split>
  )
}

// ---- The choice

function Choose({
  choice,
  onChoose,
  onBack,
  onContinue,
}: {
  choice: Choice | null
  onChoose: (choice: Choice) => void
  onBack: () => void
  onContinue: () => void
}) {
  const { t } = useTranslation('onboarding')
  const self = choice === 'self-hosted'
  return (
    <div className="kob-desk">
      <div className="kob-card">
        <div className="kob-scene" data-choice={self ? 'self-hosted' : 'account'}>
          <img
            className="kob-scene__img"
            data-scene="account"
            data-time="day"
            src={sceneAccountDay}
            alt=""
          />
          <img
            className="kob-scene__img"
            data-scene="account"
            data-time="night"
            src={sceneAccountNight}
            alt=""
          />
          <img
            className="kob-scene__img"
            data-scene="self-hosted"
            data-time="day"
            src={sceneSelfHostedDay}
            alt=""
          />
          <img
            className="kob-scene__img"
            data-scene="self-hosted"
            data-time="night"
            src={sceneSelfHostedNight}
            alt=""
          />
        </div>
        <div className="kob-card__in">
          <Steps at={2} count={self ? 3 : 4} />
          <h1 className="kob-title">{t('choose.title')}</h1>
          <p className="kob-lead">{t('choose.lead')}</p>
          <RadioGroup
            className="kob-opts"
            value={choice}
            onValueChange={(value) => onChoose(value as Choice)}
            aria-label={t('choose.title')}
          >
            <Option
              value="account"
              hero={<BrandIcon size={40} />}
              name={t('choose.account.name')}
              badge={t('choose.account.badge')}
              desc={t('choose.account.desc')}
              tint="fox"
              items={[
                [Globe02Icon, t('choose.account.network')],
                [Notification01Icon, t('choose.account.notifications')],
                [BrowserIcon, t('choose.account.web')],
                [Link01Icon, t('choose.account.share')],
              ]}
              note={[SquareLock02Icon, t('choose.account.note')]}
            />
            <Option
              value="self-hosted"
              hero={<SelfHostedMark size={40} />}
              name={t('choose.selfHosted.name')}
              desc={t('choose.selfHosted.desc')}
              tint="snow"
              items={[
                [Wifi01Icon, t('choose.selfHosted.network')],
                [ComputerTerminal01Icon, t('choose.selfHosted.ssh')],
                [CloudIcon, t('choose.selfHosted.cloudflare')],
                [UserCircleIcon, t('choose.selfHosted.account')],
              ]}
              note={[Home01Icon, t('choose.selfHosted.note')]}
            />
          </RadioGroup>
        </div>
        <footer className="kob-card__foot">
          <BackButton onClick={onBack} />
          <span className="grow" />
          <Button size="lg" disabled={choice === null} onClick={onContinue}>
            {t('continue')}
          </Button>
        </footer>
      </div>
    </div>
  )
}

type IconData = Parameters<typeof Icon>[0]['icon']

function Option({
  value,
  hero,
  name,
  badge,
  desc,
  tint,
  items,
  note,
}: {
  value: Choice
  hero: ReactNode
  name: string
  badge?: string
  desc: string
  tint: 'fox' | 'snow'
  items: [IconData, string][]
  note: [IconData, string]
}) {
  return (
    <Radio.Root value={value} render={<div />} className="kob-opt">
      <span className="kob-opt__dot" aria-hidden />
      <span className="kob-opt__head">
        <span className="kob-opt__hero">{hero}</span>
        <span className="kob-opt__text">
          <b>
            {name}
            {badge && <span className="kob-badge">{badge}</span>}
          </b>
          <small>{desc}</small>
        </span>
      </span>
      <ul className="kob-opt__list">
        {items.map(([icon, text]) => (
          <li key={text}>
            <span className="kob-gt" data-tint={tint}>
              <Icon icon={icon} size={14} />
            </span>
            {text}
          </li>
        ))}
      </ul>
      <span className="kob-opt__note">
        <Icon icon={note[0]} size={13} />
        {note[1]}
      </span>
    </Radio.Root>
  )
}

// ---- Sign in

function SignIn({
  onBack,
  onNext,
  count,
}: {
  onBack: () => void
  onNext: () => void
  count: number
}) {
  const { t } = useTranslation('onboarding')
  const { t: ts } = useTranslation('settings')
  const status = useAccountStore((s) => s.status)
  const state = signInState(status)

  if (status?.state === 'signed-in') {
    const { account, plan, usage, manageUrl } = status
    return (
      <Split
        head={<Steps at={3} count={count} />}
        stage={<CloudDiagram signedIn={account.name ?? account.email} />}
        foot={
          <>
            <BackButton onClick={onBack} />
            <span className="grow" />
            <Button size="lg" autoFocus onClick={onNext}>
              {t('continue')}
            </Button>
          </>
        }
      >
        <h1 className="kob-title">{t('signIn.doneTitle')}</h1>
        <p className="kob-lead">{t('signIn.doneLead')}</p>
        <div className="kob-panel kob-account">
          <div className="kob-account__top">
            {account.avatar ? (
              <img className="kob-avatar" src={account.avatar} alt="" />
            ) : (
              <span className="kob-avatar" aria-hidden>
                {(account.name ?? account.email).slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="kob-account__who">
              <b>
                {account.name ?? account.email}
                {plan && (
                  <span className="kob-badge" data-tone="quiet">
                    {plan.name}
                  </span>
                )}
              </b>
              {account.name && <small>{account.email}</small>}
            </span>
          </div>
          {plan && usage && (
            <div className="kob-account__row">
              <span className="grow">{t('signIn.devices')}</span>
              <span>{t('signIn.devicesUsed', { used: usage.devices, max: plan.maxDevices })}</span>
              <span className="kob-meter">
                <i
                  style={{ width: `${Math.min(100, (usage.devices / plan.maxDevices) * 100)}%` }}
                />
              </span>
            </div>
          )}
          <div className="kob-account__row">
            <span className="grow">{t('signIn.manage')}</span>
            <a
              className="kob-link app-region-no-drag"
              href={manageUrl}
              target="_blank"
              rel="noreferrer"
            >
              {t('signIn.open')}
              <Icon icon={ArrowUpRight01Icon} size={12} />
            </a>
          </div>
        </div>
      </Split>
    )
  }

  const failure = status?.state === 'signed-out' ? status.failure : null
  return (
    <Split
      head={<Steps at={3} count={count} />}
      stage={
        <BrowserStage
          page={
            state === 'waiting' ? 'confirm' : failure === 'device-limit' ? 'devices' : 'sign-in'
          }
        />
      }
      foot={<BackButton onClick={onBack} />}
    >
      <h1 className="kob-title">{t('signIn.title')}</h1>
      <p className="kob-lead">{t('signIn.lead')}</p>
      {state === 'waiting' ? (
        <div className="kob-panel kob-wait" role="status">
          <div className="kob-wait__row">
            <RingSpinner />
            <span>
              <b>{t('signIn.waiting')}</b>
              <small>{t('signIn.waitingHint')}</small>
            </span>
          </div>
          <div className="kob-wait__actions">
            <Button variant="outline" size="sm" onClick={() => void reopen()}>
              <Icon icon={ArrowUpRight01Icon} size={13} />
              {t('signIn.openAgain')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void cancelSignIn()}>
              {t('signIn.cancel')}
            </Button>
          </div>
        </div>
      ) : failure ? (
        <>
          <div className="kob-notice" role="alert">
            <Icon icon={Alert02Icon} size={16} />
            <span>
              <b>{t('signIn.failed')}</b>
              <p>{ts(`account.failures.${failure}`)}</p>
            </span>
          </div>
          <div className="kob-cta">
            <Button size="lg" onClick={() => void signIn()}>
              {t('signIn.retry')}
            </Button>
            <Button variant="ghost" size="lg" onClick={onNext}>
              {t('signIn.later')}
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="kob-cta">
            <Button size="lg" autoFocus onClick={() => void signIn()}>
              {t('signIn.browser')}
              <Icon icon={ArrowUpRight01Icon} size={14} />
            </Button>
            <Button variant="ghost" size="lg" onClick={onNext}>
              {t('signIn.later')}
            </Button>
          </div>
          <p className="kob-fine">
            <Icon icon={InformationCircleIcon} size={13} />
            {t('signIn.fine')}
          </p>
        </>
      )}
    </Split>
  )
}

function signInState(status: AccountStatus | null): 'idle' | 'waiting' | 'done' {
  if (status?.state === 'signing-in') return 'waiting'
  if (status?.state === 'signed-in') return 'done'
  return 'idle'
}

// Opens the sign-in page again: the open one is dropped, as its loopback port closes.
async function reopen(): Promise<void> {
  await cancelSignIn()
  await signIn()
}

// ---- Agents

function Agents({
  at,
  count,
  onBack,
  onFinish,
}: {
  at: number
  count: number
  onBack: () => void
  onFinish: () => void
}) {
  const { t } = useTranslation('onboarding')
  const agents = useAgentsStore(
    useShallow((s) =>
      s.loaded ? menuAgents(s.order, s.byId).filter((a) => a.id !== 'fake-agent') : null,
    ),
  )
  const guide = useGuideStatuses()
  const none = agents !== null && agents.length === 0

  return (
    <Split
      head={<Steps at={at} count={count} />}
      stage={none ? <NoAgentsStage /> : <AgentsStage agents={agents ?? []} />}
      foot={
        <>
          <BackButton onClick={onBack} />
          <span className="grow" />
          {none && (
            <Button variant="outline" size="lg" onClick={onFinish}>
              {t('agents.skip')}
            </Button>
          )}
          <Button size="lg" disabled={!agents || none} onClick={onFinish}>
            {t('agents.start')}
            <Icon icon={ArrowRight01Icon} size={14} />
          </Button>
        </>
      }
    >
      <h1 className="kob-title">{none ? t('agents.noneTitle') : t('agents.title')}</h1>
      <p className="kob-lead">{none ? t('agents.noneLead') : t('agents.lead')}</p>
      {agents === null ? (
        <p className="kob-fine" role="status">
          <RingSpinner />
          {t('agents.loading')}
        </p>
      ) : none ? (
        <div className="kob-guide">{guide && <AgentGuide statuses={guide} bare />}</div>
      ) : (
        <>
          <ul className="kob-panel kob-agents">
            {agents.map((status) => (
              <AgentRow key={status.id} status={status} />
            ))}
          </ul>
          <p className="kob-fine">
            <Icon icon={CheckmarkCircle02Icon} size={13} />
            {t('agents.note')}
          </p>
        </>
      )}
    </Split>
  )
}

function AgentRow({ status }: { status: AgentStatus }) {
  const { t } = useTranslation('onboarding')
  const ready = agentNeed(status) === null
  const line = agentLine(status)
  return (
    <li className="kob-agent">
      <span className="kob-agent__tile">
        <AgentTile agent={status.id} size={20} />
      </span>
      <span className="kob-agent__name">
        <b>{status.name}</b>
        {line && <small>{line.text}</small>}
      </span>
      {ready && (
        <span className="kob-agent__ready">
          <Icon icon={CheckmarkCircle02Icon} size={14} />
          {t('agents.ready')}
        </span>
      )}
    </li>
  )
}
