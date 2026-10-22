// The scripted scenarios the fake agent plays. Each returns the turn's stop reason.

import { join } from 'node:path'
import { RequestError } from '@agentclientprotocol/sdk/unstable'
import type {
  ContentBlock,
  PermissionOption,
  PlanEntry,
  SessionUpdate,
  StopReason,
  ToolKind,
} from '@agentclientprotocol/sdk/unstable'
import {
  BASIC_DONE,
  BASIC_REPLY,
  CLOCK_AFTER,
  CLOCK_BEFORE,
  COMMANDS,
  THINKING_ANSWER,
  THOUGHT_TEXT,
  chunkText,
  commandOutput,
  fakeFile,
  longMarkdown,
  tokenChunks,
} from './content.ts'
import type { ScenarioName } from './options.ts'
import type { Scenario, Turn } from './turn.ts'

// A 1x1 transparent PNG, so image content has something valid to decode.
const PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

export const ALL_PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
  { optionId: 'reject-always', name: 'Always reject', kind: 'reject_always' },
]

interface StreamOptions {
  kind?: 'agent' | 'thought'
  messageId?: string
  delayMs?: number
  chunks?: string[]
  sessionId?: string
}

/** Streams text in token-sized chunks; returns false if the turn was cancelled. */
async function stream(turn: Turn, text: string, options: StreamOptions = {}): Promise<boolean> {
  const chunks = options.chunks ?? groupTokens(tokenChunks(text), 3)
  const sessionUpdate = options.kind === 'thought' ? 'agent_thought_chunk' : 'agent_message_chunk'
  for (const chunk of chunks) {
    if (turn.signal.aborted) return false
    await turn.send(
      {
        sessionUpdate,
        content: { type: 'text', text: chunk },
        ...(options.messageId ? { messageId: options.messageId } : {}),
      },
      options.sessionId,
    )
    await turn.sleep(options.delayMs ?? 30)
  }
  return !turn.signal.aborted
}

function groupTokens(tokens: string[], size: number): string[] {
  const groups: string[] = []
  for (let i = 0; i < tokens.length; i += size) groups.push(tokens.slice(i, i + size).join(''))
  return groups
}

function filePath(turn: Turn, relative: string): string {
  return join(turn.session.cwd, relative)
}

/** Context usage plus the two plan windows, as claude-agent-acp reports them. */
export async function sendUsage(turn: Turn, extraTokens = 1800): Promise<void> {
  const session = turn.session
  session.usedTokens = Math.min(200_000, session.usedTokens + extraTokens)
  const now = Math.floor(Date.now() / 1000)
  const { fiveHour, weekly } = planWindows(session.turns)
  const windows = [
    { rateLimitType: 'five_hour', utilization: fiveHour, resetsAt: now + 2 * 3600 + 840 },
    { rateLimitType: 'seven_day', utilization: weekly, resetsAt: now + 3 * 86400 + 7200 },
  ]
  for (const window of windows) {
    await turn.send({
      sessionUpdate: 'usage_update',
      used: session.usedTokens,
      size: 200_000,
      cost: { amount: Math.round(session.usedTokens * 0.3) / 100_000, currency: 'USD' },
      _meta: {
        '_claude/rateLimit': {
          status: window.utilization >= 0.8 ? 'allowed_warning' : 'allowed',
          ...window,
        },
      },
    })
  }
}

const basicTurn: Scenario = async (turn) => {
  const intro = turn.text ? `> ${turn.text.split('\n')[0]}\n\n` : ''
  if (!(await stream(turn, intro + BASIC_REPLY, { messageId: turn.messageId() }))) {
    return 'cancelled'
  }
  const toolCallId = `edit-${turn.session.turns}`
  const path = filePath(turn, 'src/clock.ts')
  await turn.send({
    sessionUpdate: 'tool_call',
    toolCallId,
    title: 'Edit src/clock.ts',
    kind: 'edit',
    status: 'pending',
    locations: [{ path, line: 1 }],
    rawInput: { file_path: path, old_string: CLOCK_BEFORE, new_string: CLOCK_AFTER },
  })
  await turn.sleep(150)
  await turn.send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' })
  await turn.sleep(250)
  await turn.send({
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'completed',
    content: [{ type: 'diff', path, oldText: CLOCK_BEFORE, newText: CLOCK_AFTER }],
  })
  if (!(await stream(turn, BASIC_DONE, { messageId: turn.messageId() }))) return 'cancelled'
  await sendUsage(turn)
  return 'end_turn'
}

const longStream: Scenario = async (turn) => {
  const text = longMarkdown(turn.options.size)
  const chunks = chunkText(text, 100)
  const interval = 1000 / turn.options.rate
  const start = Date.now()
  for (let i = 0; i < chunks.length; i++) {
    if (turn.signal.aborted) return 'cancelled'
    await turn.send({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: chunks[i]! },
    })
    const wait = start + (i + 1) * interval - Date.now()
    await turn.sleep(Math.max(0, wait))
  }
  await sendUsage(turn, Math.round(text.length / 4))
  return 'end_turn'
}

const TOOL_KINDS: ToolKind[] = ['read', 'search', 'edit', 'execute', 'read', 'fetch', 'think']

const toolStorm: Scenario = async (turn) => {
  if (!(await stream(turn, 'Scanning the repository before I change anything.\n\n'))) {
    return 'cancelled'
  }
  for (let i = 0; i < turn.options.count; i++) {
    if (turn.signal.aborted) return 'cancelled'
    const kind = TOOL_KINDS[i % TOOL_KINDS.length]!
    const toolCallId = `storm-${turn.session.turns}-${i}`
    const file = fakeFile(i)
    const path = filePath(turn, file)
    const command = COMMANDS[i % COMMANDS.length]!
    const title =
      kind === 'read'
        ? `Read ${file}`
        : kind === 'search'
          ? `Search for "token" in ${file}`
          : kind === 'edit'
            ? `Edit ${file}`
            : kind === 'execute'
              ? `Run ${command}`
              : kind === 'fetch'
                ? 'Fetch https://agentclientprotocol.com/protocol/tool-calls'
                : 'Think about the next step'
    await turn.send({
      sessionUpdate: 'tool_call',
      toolCallId,
      title,
      kind,
      status: 'pending',
      locations: kind === 'read' || kind === 'edit' ? [{ path, line: (i % 40) + 1 }] : [],
      rawInput: kind === 'execute' ? { command } : { path },
    })
    await turn.send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' })
    await turn.sleep(2)
    await turn.send({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: i % 97 === 13 ? 'failed' : 'completed',
      content:
        kind === 'edit'
          ? [
              {
                type: 'diff',
                path,
                oldText: `const value = ${i}\n`,
                newText: `const value = ${i + 1}\n`,
              },
            ]
          : [
              {
                type: 'content',
                content: {
                  type: 'text',
                  text:
                    kind === 'execute'
                      ? '```\n' + commandOutput(command, i) + '```'
                      : `Line ${(i % 40) + 1}: \`issueToken(user, now)\``,
                },
              },
            ],
    })
    await turn.sleep(2)
  }
  if (
    !(await stream(turn, `\nChecked ${turn.options.count} places. Nothing else needs to change.`))
  ) {
    return 'cancelled'
  }
  await sendUsage(turn, 12_000)
  return 'end_turn'
}

async function runCommand(
  turn: Turn,
  toolCallId: string,
  command: string,
  outcome: string,
  sessionId?: string,
): Promise<void> {
  if (outcome.startsWith('allow')) {
    await turn.send(
      { sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' },
      sessionId,
    )
    await turn.sleep(400)
    await turn.send(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'completed',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: '```\n' + commandOutput(command, 1) + '```' },
          },
        ],
        rawOutput: { exitCode: 0 },
      },
      sessionId,
    )
  } else {
    await turn.send(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: 'The user declined.' } }],
      },
      sessionId,
    )
  }
}

const permission: Scenario = async (turn) => {
  if (!(await stream(turn, 'I need to run the test suite to check the fix.\n\n')))
    return 'cancelled'
  const toolCallId = `cmd-${turn.session.turns}`
  const command = 'pnpm test --filter login'
  await turn.send({
    sessionUpdate: 'tool_call',
    toolCallId,
    title: `Run ${command}`,
    kind: 'execute',
    status: 'pending',
    rawInput: { command, description: 'Runs the login tests' },
  })
  const outcome = await turn.requestPermission(
    { toolCallId, title: `Run ${command}`, kind: 'execute', rawInput: { command } },
    ALL_PERMISSION_OPTIONS,
    { withdrawAfterMs: turn.options.withdrawMs },
  )
  if (outcome === 'cancelled') return 'cancelled'
  if (outcome === 'withdrawn') {
    await turn.send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' })
    await stream(turn, 'I withdrew the request; the tests can wait.')
    return 'end_turn'
  }
  await runCommand(turn, toolCallId, command, outcome)
  const reply = outcome.startsWith('allow')
    ? 'All 12 login tests pass. '
    : 'OK, I will not run it. '
  await stream(turn, reply + `You chose \`${outcome}\`.`)
  await sendUsage(turn)
  return 'end_turn'
}

const parallelPermissions: Scenario = async (turn) => {
  if (!(await stream(turn, 'Three things need your approval.\n\n'))) return 'cancelled'
  const calls: { id: string; title: string; kind: ToolKind; command: string }[] = [
    { id: 'lint', title: 'Run pnpm lint --fix', kind: 'execute', command: 'pnpm lint --fix' },
    { id: 'pkg', title: 'Edit package.json', kind: 'edit', command: 'edit package.json' },
    { id: 'cache', title: 'Delete .cache', kind: 'delete', command: 'rm -rf .cache' },
  ]
  for (const call of calls) {
    await turn.send({
      sessionUpdate: 'tool_call',
      toolCallId: `${call.id}-${turn.session.turns}`,
      title: call.title,
      kind: call.kind,
      status: 'pending',
      rawInput: { command: call.command },
    })
  }
  const outcomes = await Promise.all(
    calls.map((call) =>
      turn.requestPermission(
        { toolCallId: `${call.id}-${turn.session.turns}`, title: call.title, kind: call.kind },
        ALL_PERMISSION_OPTIONS.filter((option) => option.kind !== 'reject_always'),
      ),
    ),
  )
  if (outcomes.includes('cancelled')) return 'cancelled'
  for (const [index, call] of calls.entries()) {
    await runCommand(turn, `${call.id}-${turn.session.turns}`, call.command, outcomes[index]!)
  }
  await stream(turn, `Answers: ${outcomes.map((o) => `\`${o}\``).join(', ')}.`)
  await sendUsage(turn)
  return 'end_turn'
}

const cancel: Scenario = async (turn) => {
  const deadline = Date.now() + 60_000
  let step = 0
  while (Date.now() < deadline) {
    if (turn.signal.aborted) return 'cancelled'
    const text = `Working on step ${++step}. This turn keeps going until you cancel it. `
    await turn.send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
    await turn.sleep(250)
    if (turn.signal.aborted) return 'cancelled'
    if (step % 4 === 0) {
      const toolCallId = `long-${turn.session.turns}-${step}`
      await turn.send({
        sessionUpdate: 'tool_call',
        toolCallId,
        title: `Read ${fakeFile(step)}`,
        kind: 'read',
        status: 'in_progress',
      })
      await turn.sleep(200)
      await turn.send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' })
    }
  }
  return 'end_turn'
}

// Never resolves: the process is gone before the turn could end.
const crash: Scenario = async (turn) => {
  await stream(turn, 'Starting the build. ', { messageId: turn.messageId() })
  await turn.send({
    sessionUpdate: 'tool_call',
    toolCallId: `build-${turn.session.turns}`,
    title: 'Run pnpm build',
    kind: 'execute',
    status: 'in_progress',
  })
  await turn.sleep(300)
  turn.log(`fake-agent: crashing with exit code ${turn.options.exitCode}`)
  turn.exit(turn.options.exitCode)
  return new Promise<StopReason>(() => {})
}

const error: Scenario = async (turn) => {
  await stream(turn, 'Checking the build. ', { messageId: turn.messageId() })
  throw RequestError.internalError(undefined, 'The fake agent failed this turn on purpose')
}

const authRequired: Scenario = async (turn) => {
  // Clients send the failed prompt again after sign-in; like a real agent, that one succeeds.
  if (turn.session.signedOut) {
    turn.session.signedOut = false
    await stream(turn, 'Signed in again, so the session picks up where it was.')
    return 'end_turn'
  }
  turn.session.signedOut = true
  turn.signOut()
  throw RequestError.authRequired(undefined, 'Sign in to the fake agent to continue')
}

const largeHistory: Scenario = async (turn) => {
  const entries = turn.options.entries
  turn.session.largeHistory = entries
  await stream(
    turn,
    `This session now has a **${entries.toLocaleString('en')}-entry** history for \`session/load\` to replay. OverBench replays only a session it has stored no thread of, such as an imported one: import \`history-<n>\` for one with n entries.`,
  )
  return 'end_turn'
}

const slowStart: Scenario = async (turn) => {
  await stream(
    turn,
    'Slow start happens before any prompt, so it is chosen at launch: set `FAKE_AGENT_SCENARIO=slow-start` (or `FAKE_AGENT_SLOW_START_MS`) before starting OverBench, then start a session. `initialize` then takes 20 s and prints progress to stderr.',
  )
  return 'end_turn'
}

const allUpdates: Scenario = async (turn) => {
  const id = turn.session.turns
  const path = filePath(turn, 'src/clock.ts')
  const updates: SessionUpdate[] = [
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Echoed user text' } },
    {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Thinking about every update.' },
    },
    {
      sessionUpdate: 'agent_message_chunk',
      messageId: `all-${id}`,
      content: { type: 'text', text: 'Every **update** variant, once.\n\n' },
    },
    {
      sessionUpdate: 'agent_message_chunk',
      messageId: `all-${id}`,
      content: { type: 'image', mimeType: 'image/png', data: PIXEL_PNG },
    },
    {
      sessionUpdate: 'agent_message_chunk',
      messageId: `all-${id}`,
      content: { type: 'resource_link', uri: 'file:///README.md', name: 'README.md' },
    },
    {
      sessionUpdate: 'agent_message_chunk',
      messageId: `all-${id}`,
      content: { type: 'audio', mimeType: 'audio/wav', data: 'UklGRiQAAABXQVZF' },
    },
    {
      sessionUpdate: 'agent_message_chunk',
      messageId: `all-${id}`,
      content: {
        type: 'resource',
        resource: { uri: 'file:///notes.txt', text: 'Embedded notes', mimeType: 'text/plain' },
      },
    },
    {
      sessionUpdate: 'tool_call',
      toolCallId: `all-tool-${id}`,
      title: 'Read src/clock.ts',
      kind: 'read',
      status: 'pending',
      locations: [{ path, line: 3 }],
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: `all-tool-${id}`,
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: 'line one\r\nline two\r\n' } },
        { type: 'diff', path, oldText: null, newText: 'export const created = true\n' },
      ],
      locations: [{ path }],
      rawOutput: { bytes: 120 },
    },
    {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Send every update', priority: 'high', status: 'completed' },
        { content: 'Check the thread', priority: 'medium', status: 'in_progress' },
        { content: 'Tidy up', priority: 'low', status: 'pending' },
      ],
    },
    {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'compact', description: 'Summarize the conversation' }],
    },
    { sessionUpdate: 'current_mode_update', currentModeId: 'code' },
    {
      sessionUpdate: 'session_info_update',
      title: 'Every update variant',
      updatedAt: new Date().toISOString(),
    },
    { sessionUpdate: 'notice', severity: 'info', title: 'An info notice' },
    {
      sessionUpdate: 'notice',
      severity: 'warning',
      title: 'A warning notice',
      description: 'With a description.',
    },
    { sessionUpdate: 'notice', severity: 'error', title: 'An error notice' },
    { sessionUpdate: 'notice', severity: 'debug', title: 'A notice with an unknown severity' },
    { sessionUpdate: 'compaction_update', compactionId: `all-c-${id}`, status: 'in_progress' },
    {
      sessionUpdate: 'compaction_summary_chunk',
      compactionId: `all-c-${id}`,
      content: { type: 'text', text: 'Summary of the conversation.' },
    },
    { sessionUpdate: 'compaction_update', compactionId: `all-c-${id}`, status: 'completed' },
  ]
  for (const update of updates) {
    await turn.send(update)
    await turn.sleep(20)
  }
  await sendUsage(turn, 500)
  if (turn.supportsSubagents) {
    const child = `${turn.session.id}-all-sub-${id}`
    await turn.send({
      sessionUpdate: 'subagent_update',
      sessionId: child,
      title: 'A quick child',
      state: { state: 'running' },
    })
    await turn.send(
      {
        sessionUpdate: 'session_message',
        messageId: `all-sm-${id}`,
        senderSessionId: turn.session.id,
        recipientSessionId: child,
        content: [{ type: 'text', text: 'Say hello.' }],
      },
      child,
    )
    await turn.send(
      {
        sessionUpdate: 'session_message_chunk',
        messageId: `all-sm-${id}`,
        content: { type: 'text', text: ' Then stop.' },
      },
      child,
    )
    await turn.send({
      sessionUpdate: 'subagent_update',
      sessionId: child,
      state: { state: 'idle', stopReason: 'end_turn' },
    })
  }
  await turn.sendRaw({ sessionUpdate: 'future_update', value: 42 })
  return 'end_turn'
}

const subagent: Scenario = async (turn) => {
  if (
    !(await stream(turn, 'I will ask a subagent to explore the repository first.\n\n', {
      messageId: turn.messageId(),
    }))
  ) {
    return 'cancelled'
  }
  const n = turn.session.turns
  if (!turn.supportsSubagents) {
    await turn.send({
      sessionUpdate: 'tool_call',
      toolCallId: `task-${n}`,
      title: 'Explore the repository (subagent)',
      kind: 'think',
      status: 'completed',
      content: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: 'The client did not advertise subagents, so this stays a tool call.',
          },
        },
      ],
    })
    return 'end_turn'
  }
  const child = `${turn.session.id}-sub-${n}`
  let childCancelled = false
  turn.registerChild(child, () => {
    childCancelled = true
  })
  const startedAt = Date.now()
  await turn.send({
    sessionUpdate: 'subagent_update',
    sessionId: child,
    title: 'Explore the repository',
    description: 'Find where the session token is issued and validated',
    capabilities: { cancel: {} },
    state: { state: 'running' },
  })
  await turn.send(
    {
      sessionUpdate: 'session_message',
      messageId: `delegate-${n}`,
      senderSessionId: turn.session.id,
      recipientSessionId: child,
      content: [
        {
          type: 'text',
          text: 'Find every place that reads the clock while issuing or validating a token. Report file and line.',
        },
      ],
    },
    child,
  )
  await stream(turn, 'Looking for clock reads.', { sessionId: child, messageId: `child-${n}-1` })
  for (const [index, file] of ['src/clock.ts', 'src/auth/session.ts'].entries()) {
    const toolCallId = `child-read-${n}-${index}`
    await turn.send(
      {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: `Read ${file}`,
        kind: 'read',
        status: 'in_progress',
        locations: [{ path: filePath(turn, file) }],
      },
      child,
    )
    await turn.sleep(200)
    await turn.send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' }, child)
  }
  const grep = `child-grep-${n}`
  await turn.send(
    {
      sessionUpdate: 'tool_call',
      toolCallId: grep,
      title: 'Run rg "Date.now" src',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'rg "Date.now" src' },
    },
    child,
  )
  await turn.send({
    sessionUpdate: 'subagent_update',
    sessionId: child,
    state: { state: 'requires_action' },
  })
  const outcome = await turn.requestPermission(
    {
      toolCallId: grep,
      title: 'Run rg "Date.now" src',
      kind: 'execute',
      rawInput: { command: 'rg "Date.now" src' },
    },
    ALL_PERMISSION_OPTIONS.slice(0, 3),
    { sessionId: child },
  )
  await turn.send({
    sessionUpdate: 'subagent_update',
    sessionId: child,
    state: { state: 'running' },
  })
  if (outcome === 'cancelled' || childCancelled) {
    await turn.send({
      sessionUpdate: 'subagent_update',
      sessionId: child,
      state: { state: 'idle', stopReason: 'cancelled' },
    })
    return turn.signal.aborted ? 'cancelled' : 'end_turn'
  }
  await runCommand(turn, grep, 'rg "Date.now" src', outcome, child)
  await stream(turn, '\n\nFound two reads: `src/clock.ts:2` and `src/clock.ts:6`.', {
    sessionId: child,
    messageId: `child-${n}-2`,
  })
  const elapsed = Date.now() - startedAt
  await turn.send({
    sessionUpdate: 'subagent_update',
    sessionId: child,
    state: {
      state: 'idle',
      stopReason: 'end_turn',
      usage: { totalTokens: 5200 + (elapsed % 100), inputTokens: 4800, outputTokens: 400 },
    },
  })
  await stream(turn, 'The subagent found both clock reads, so the fix from before covers them.', {
    messageId: turn.messageId(),
  })
  await sendUsage(turn)
  return 'end_turn'
}

const plan: Scenario = async (turn) => {
  const items = [
    'Read the failing test',
    'Find the second clock read',
    'Thread one timestamp through',
    'Add a fake-timer regression test',
  ]
  const entries = (done: number): PlanEntry[] =>
    items.map((content, index) => ({
      content,
      priority: index === 0 ? 'high' : index === items.length - 1 ? 'low' : 'medium',
      status: index < done ? 'completed' : index === done ? 'in_progress' : 'pending',
    }))
  for (let done = 0; done <= items.length; done++) {
    if (turn.signal.aborted) return 'cancelled'
    await turn.send({ sessionUpdate: 'plan', entries: entries(done) })
    if (done === items.length) break
    await stream(turn, `${items[done]}… `, { delayMs: 40 })
    const toolCallId = `plan-${turn.session.turns}-${done}`
    await turn.send({
      sessionUpdate: 'tool_call',
      toolCallId,
      title: `Read ${fakeFile(done)}`,
      kind: 'read',
      status: 'in_progress',
    })
    await turn.sleep(300)
    await turn.send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' })
  }
  await stream(turn, '\n\nAll four steps are done.')
  await sendUsage(turn)
  return 'end_turn'
}

// Claude Code's Bash call returns as soon as the command goes to the background, and it tells a
// client without terminals nothing of the command after that.
const background: Scenario = async (turn) => {
  const toolCallId = `background-${turn.session.turns}`
  await turn.send({
    sessionUpdate: 'tool_call',
    toolCallId,
    title: 'npm run dev',
    kind: 'execute',
    status: 'in_progress',
    rawInput: {
      command: 'npm run dev',
      description: 'Start the dev server',
      run_in_background: true,
    },
  })
  await turn.sleep(100)
  await turn.send({
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'completed',
    content: [
      {
        type: 'content',
        content: { type: 'text', text: 'Command running in background with ID: b1' },
      },
    ],
  })
  await stream(turn, 'The dev server runs in the background.')
  return 'end_turn'
}

const thinking: Scenario = async (turn) => {
  if (
    !(await stream(turn, THOUGHT_TEXT, {
      kind: 'thought',
      delayMs: 25,
      chunks: tokenChunks(THOUGHT_TEXT),
    }))
  ) {
    return 'cancelled'
  }
  if (!(await stream(turn, THINKING_ANSWER, { messageId: turn.messageId() }))) return 'cancelled'
  await sendUsage(turn)
  return 'end_turn'
}

// The plan windows of sendUsage, as fractions.
function planWindows(turns: number): { fiveHour: number; weekly: number } {
  return {
    fiveHour: Math.min(0.99, 0.12 + turns * 0.07),
    weekly: Math.min(0.99, 0.31 + turns * 0.01),
  }
}

/** The adapter's reset format (`formatReset` in claude-agent-acp's usage-markdown.js). */
function resetText(at: number): string {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(at)
}

function usageBar(percent: number): string {
  const filled = percent === 0 ? 0 : Math.max(1, Math.round((percent / 100) * 20))
  return `${'█'.repeat(filled)}${'░'.repeat(20 - filled)}`
}

/** `/usage` as claude-agent-acp 0.94 formats it, with the windows sendUsage pushes. */
const usage: Scenario = async (turn) => {
  const { fiveHour, weekly } = planWindows(turn.session.turns)
  const now = Date.now()
  const limit = (label: string, share: number, resetsAt: number): string[] => {
    const percent = Math.round(share * 100)
    return [
      `**${label}** — **${percent}%** · Resets ${resetText(resetsAt)}`,
      '',
      `\`${usageBar(percent)}\``,
      '',
    ]
  }
  const report = [
    '## Usage',
    '',
    '> Claude fake subscription usage',
    '',
    '### Limits',
    '',
    ...limit('5-hour limit', fiveHour, now + 2 * 3600_000 + 840_000),
    ...limit('Weekly · all models', weekly, now + 3 * 86_400_000 + 7_200_000),
    ...limit('Weekly · Fake', 0.07, now + 3 * 86_400_000 + 7_200_000),
    '---',
    '',
    '### This session',
  ].join('\n')
  await stream(turn, report, { chunks: [report], delayMs: 0 })
  return 'end_turn'
}

/** A reset as codex-acp's `formatResetTime` writes it, in this machine's locale. */
function statusReset(at: number): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  if (date.toDateString() === new Date().toDateString()) return ` (resets ${time})`
  return ` (resets ${time} on ${date.toLocaleDateString([], { day: 'numeric', month: 'short' })})`
}

/** `/status` as codex-acp 2.2.2 formats it (`buildStatusMessage`), with the windows of /usage. */
const status: Scenario = async (turn) => {
  const { fiveHour, weekly } = planWindows(turn.session.turns)
  const now = Date.now()
  const left = (share: number): number => Math.round(100 - share * 100)
  const report = [
    '**Model:** fake-model',
    `**Directory:** ${turn.session.cwd}`,
    '**Approval:** on-request',
    '**Sandbox:** workspace-write',
    '**Account:** ChatGPT plus (fake@example.com)',
    `**Session:** \`${turn.session.id}\``,
    '',
    '**Token usage:** data not available yet',
    '**Context window:** data not available yet',
    `**codex 5h limit:** ${left(fiveHour)}% left${statusReset(now + 2 * 3600_000 + 840_000)}`,
    `**codex Weekly limit:** ${left(weekly)}% left${statusReset(now + 3 * 86_400_000)}`,
    '**codex Credits:** 120',
  ].join('  \n')
  await stream(turn, report, { chunks: [report], delayMs: 0 })
  return 'end_turn'
}

/** `/context` as Claude Code 2.1 reports it, for the fake session's tokens. */
const context: Scenario = async (turn) => {
  const size = 200_000
  const fixed = {
    'System prompt': 3_100,
    'System tools': 8_400,
    'MCP tools': 640,
    'Memory files': 900,
  }
  const messages = Math.max(500, turn.session.usedTokens)
  const used = Object.values(fixed).reduce((sum, n) => sum + n, messages)
  const buffer = 33_000
  const k = (n: number): string => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n))
  const pct = (n: number): string => `${Math.round((n / size) * 1000) / 10}%`
  const rows = [
    ...Object.entries(fixed),
    ['Messages', messages] as const,
    ['Free space', size - used - buffer] as const,
    ['Autocompact buffer', buffer] as const,
  ]
  const report = [
    '## Context Usage',
    '',
    '**Model:** fake-model  ',
    `**Tokens:** ${k(used)} / ${k(size)} (${Math.round((used / size) * 100)}%)`,
    '',
    '### Estimated usage by category',
    '',
    '| Category | Tokens | Percentage |',
    '|----------|--------|------------|',
    ...rows.map(([name, n]) => `| ${name} | ${k(n)} | ${pct(n)} |`),
    '',
    '### MCP Tools',
    '',
    '| Tool | Server | Tokens |',
    '|------|--------|--------|',
    '| mcp__fake__search | fake | 340 |',
    '| mcp__fake__fetch | fake | 300 |',
    '',
    '### Memory Files',
    '',
    '| Type | Path | Tokens |',
    '|------|------|--------|',
    `| Project | ${join(turn.session.cwd, 'CLAUDE.md')} | 900 |`,
  ].join('\n')
  // Claude Code sends the report twice, under two message ids.
  for (let i = 0; i < 2; i++) {
    await stream(turn, report, { chunks: [report], delayMs: 0, messageId: turn.messageId() })
  }
  return 'end_turn'
}

export const SCENARIO_RUNNERS: Record<ScenarioName, Scenario> = {
  'basic-turn': basicTurn,
  'long-stream': longStream,
  'tool-storm': toolStorm,
  permission,
  'parallel-permissions': parallelPermissions,
  cancel,
  crash,
  error,
  'auth-required': authRequired,
  'large-history': largeHistory,
  'slow-start': slowStart,
  'all-updates': allUpdates,
  subagent,
  plan,
  background,
  thinking,
  usage,
  status,
  context,
}

export const compact: Scenario = async (turn) => {
  const compactionId = `compact-${turn.session.turns}`
  await turn.send({ sessionUpdate: 'compaction_update', compactionId, status: 'in_progress' })
  for (const chunk of groupTokens(
    tokenChunks(
      'We fixed the flaky login test by reading the clock once and added a regression test.',
    ),
    4,
  )) {
    await turn.send({
      sessionUpdate: 'compaction_summary_chunk',
      compactionId,
      content: { type: 'text', text: chunk },
    })
    await turn.sleep(40)
  }
  await turn.send({ sessionUpdate: 'compaction_update', compactionId, status: 'completed' })
  turn.session.usedTokens = Math.round(turn.session.usedTokens / 5)
  await sendUsage(turn, 0)
  return 'end_turn'
}

/** A replayed history of about `entries` thread entries, for `session/load`. */
export function* syntheticHistory(entries: number): Generator<SessionUpdate> {
  const turns = Math.max(1, Math.ceil(entries / 4))
  for (let i = 0; i < turns; i++) {
    yield {
      sessionUpdate: 'user_message_chunk',
      messageId: `h-u-${i}`,
      content: text(`Question ${i + 1}: what does step ${i + 1} do?`),
    }
    yield {
      sessionUpdate: 'agent_message_chunk',
      messageId: `h-a-${i}`,
      content: text(`Step ${i + 1} reads \`${fakeFile(i)}\` and checks the token.`),
    }
    yield {
      sessionUpdate: 'tool_call',
      toolCallId: `h-t-${i}`,
      title: `Read ${fakeFile(i)}`,
      kind: 'read',
      status: 'completed',
    }
    yield {
      sessionUpdate: 'agent_message_chunk',
      messageId: `h-b-${i}`,
      content: text(`It is correct as written (${i + 1}/${turns}).`),
    }
  }
}

function text(value: string): ContentBlock {
  return { type: 'text', text: value }
}
