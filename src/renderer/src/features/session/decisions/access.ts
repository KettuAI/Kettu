import {
  DashboardSquare01Icon,
  Globe02Icon,
  PlugSocketIcon,
  SmartPhone01Icon,
} from '@hugeicons/core-free-icons'
import type { TFunction } from 'i18next'
import { originLabel, type BrowserOriginAnswer } from '@shared/browser'
import type { ComputerAppAnswer } from '@shared/computer-use'
import type { DeviceAccessAnswer } from '@shared/device-agent'
import type {
  BrowserOriginEntry,
  ComputerAppEntry,
  DeviceAccessEntry,
  ProjectMcpAnswer,
  ProjectMcpDecision,
  ProjectMcpEntry,
} from '@shared/thread'
import { host } from '@renderer/lib/host'
import type { AccessAsk, AccessDecision } from '../entries/access-card'
import type { Ask, AskContext } from './ask'

const ACCESS_ANSWERS: AccessDecision[] = ['session', 'always', 'deny']

/** A request for access on the Decision Card: allow for the session, always, or not. */
export function accessAsk(key: string, access: AccessAsk, ctx: AskContext): Ask {
  const { t, agentName } = ctx
  return {
    key,
    group: key,
    decision: {
      task: agentName,
      question: t('decision.allow', { agent: agentName, action: access.action }),
      facts: [
        { label: access.targetLabel, value: access.preview?.join(', ') ?? access.target },
        { label: t('decision.fact.note'), value: access.reason },
      ],
      options: [
        { id: 'session', title: access.words.allow.session },
        { id: 'always', title: access.words.allow.always },
        { id: 'deny', title: access.words.deny },
      ],
      own: false,
    },
    answer: (answer) => {
      const id = typeof answer === 'object' ? answer.option : undefined
      const decision = ACCESS_ANSWERS.find((d) => d === id)
      if (decision) void ctx.go(key, () => access.request(decision))
    },
  }
}

const ORIGIN_ANSWER = {
  session: 'browserOrigin.answer.session',
  project: 'browserOrigin.answer.project',
  deny: 'browserOrigin.answer.deny',
  timeout: 'browserOrigin.answer.timeout',
} as const satisfies Record<BrowserOriginAnswer, string>

/** What a page's request to open a new site asks, here and on the Decision Card. */
export function browserOriginAsk(
  t: TFunction<'session'>,
  sessionId: string,
  entry: BrowserOriginEntry,
): AccessAsk {
  const site = originLabel(entry.origin)
  return {
    action: t('access.action.site'),
    target: entry.origin,
    targetLabel: t('decision.fact.site'),
    glyph: Globe02Icon,
    reason: t('browserOrigin.where'),
    words: {
      allow: {
        session: t('browserOrigin.decision.session'),
        always: t('browserOrigin.decision.project', { site }),
      },
      deny: t('browserOrigin.decision.deny'),
      answer: (a) =>
        t(
          ORIGIN_ANSWER[(a === 'always' ? 'project' : a) as BrowserOriginAnswer] ??
            ORIGIN_ANSWER.deny,
        ),
    },
    request: (decision) =>
      host('browser.answerOrigin', {
        sessionId,
        entryId: entry.id,
        decision: decision === 'always' ? 'project' : decision,
      }),
  }
}

const APP_ANSWER = {
  session: 'computerApp.answer.session',
  always: 'computerApp.answer.always',
  deny: 'computerApp.answer.deny',
  timeout: 'computerApp.answer.timeout',
} as const satisfies Record<ComputerAppAnswer, string>

/** What a request to use an app asks, here and on the Decision Card. */
export function computerAppAsk(
  t: TFunction<'session'>,
  sessionId: string,
  entry: ComputerAppEntry,
): AccessAsk {
  const app = entry.appName
  return {
    action: t('access.action.app'),
    target: app,
    targetLabel: t('decision.fact.app'),
    glyph: DashboardSquare01Icon,
    reason: t('computerApp.where'),
    words: {
      allow: {
        session: t('computerApp.decision.session'),
        always: t('computerApp.decision.always', { app }),
      },
      deny: t('computerApp.decision.deny'),
      answer: (a) => t(APP_ANSWER[a as ComputerAppAnswer] ?? APP_ANSWER.deny),
    },
    request: (decision) => host('computer.answerApp', { sessionId, entryId: entry.id, decision }),
  }
}

const DEVICE_ANSWER = {
  session: 'deviceAccess.answer.session',
  always: 'deviceAccess.answer.always',
  deny: 'deviceAccess.answer.deny',
  timeout: 'deviceAccess.answer.timeout',
} as const satisfies Record<DeviceAccessAnswer, string>

/** What a request to use a mobile device asks, here and on the Decision Card. */
export function deviceAccessAsk(
  t: TFunction<'session'>,
  sessionId: string,
  entry: DeviceAccessEntry,
): AccessAsk {
  return {
    action: t('access.action.device'),
    target: entry.deviceName,
    targetLabel: t('decision.fact.device'),
    glyph: SmartPhone01Icon,
    reason: t('deviceAccess.where'),
    words: {
      allow: {
        session: t('deviceAccess.decision.session'),
        always: t('deviceAccess.decision.always'),
      },
      deny: t('deviceAccess.decision.deny'),
      answer: (a) => t(DEVICE_ANSWER[a as DeviceAccessAnswer] ?? DEVICE_ANSWER.deny),
    },
    request: (decision) => host('devices.answerAccess', { sessionId, entryId: entry.id, decision }),
  }
}

const MCP_ANSWER = {
  use: 'projectMcp.answer.use',
  all: 'projectMcp.answer.all',
  skip: 'projectMcp.answer.skip',
  timeout: 'projectMcp.answer.timeout',
} as const satisfies Record<ProjectMcpAnswer, string>

// The card's scopes: these servers, or all of the project's, later ones too.
const DECISION = {
  session: 'use',
  always: 'all',
  deny: 'skip',
} as const satisfies Record<AccessDecision, ProjectMcpDecision>

/** What the folder's own MCP servers ask, here and on the Decision Card. */
export function projectMcpAsk(
  t: TFunction<'session'>,
  sessionId: string,
  entry: ProjectMcpEntry,
): AccessAsk {
  return {
    action: t('access.action.projectMcp'),
    target: entry.servers.map((server) => server.name).join(', '),
    targetLabel: t('decision.fact.servers'),
    glyph: PlugSocketIcon,
    reason: t('projectMcp.where'),
    preview: entry.servers.map((server) =>
      server.target ? `${server.name} · ${server.target}` : server.name,
    ),
    words: {
      allow: { session: t('projectMcp.decision.use'), always: t('projectMcp.decision.all') },
      deny: t('projectMcp.decision.skip'),
      answer: () => t(MCP_ANSWER[entry.decision ?? 'skip']),
    },
    request: (decision) =>
      host('sessions.answerProjectMcp', {
        sessionId,
        entryId: entry.id,
        decision: DECISION[decision],
      }),
  }
}
