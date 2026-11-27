import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MarketSkill } from '@shared/marketplace'
import type { HostSettings } from '@shared/settings'
import { mapCommands as mapAcpCommands } from './acp/mapper'
import { scanClaudeSkillsOnDisk } from './claude/connection'
import { mapCommands as mapClaudeCommands } from './claude/mapper'
import {
  commandList as codexCommandList,
  parseCommand as parseCodexCommand,
} from './codex/commands'
import { promptBlocks, skillNotice } from './connection'
import { skillFolder } from './marketplace/skills'
import { parseCommand as parseOpenCodeCommand } from './opencode/connection'
import { commandList as piCommandList, parseCommand as parsePiCommand } from './pi/commands'
import { startTestHost, type TestHost } from './testing/harness'
import { tempFolder } from './testing/temp'

vi.setConfig({ testTimeout: 60_000 })

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

describe('harness skill classification', () => {
  it('marks Codex skills as stackable skills while keeping built-in commands exclusive', () => {
    const list = codexCommandList([
      {
        name: 'code-review',
        description: 'Review code',
        path: '/skills/code-review/SKILL.md',
        enabled: true,
      },
      {
        name: 'security-audit',
        description: 'Audit security',
        shortDescription: 'Security audit',
        path: '/skills/security-audit/SKILL.md',
        enabled: true,
      },
    ])
    expect(list.find((c) => c.name === 'compact')?.kind).toBeUndefined()
    expect(list.find((c) => c.name === 'status')?.kind).toBeUndefined()
    expect(list.find((c) => c.name === '$code-review')).toEqual({
      name: '$code-review',
      description: 'Review code',
      kind: 'skill',
    })
    expect(list.find((c) => c.name === '$security-audit')).toEqual({
      name: '$security-audit',
      description: 'Security audit',
      kind: 'skill',
    })
    // Stacked Codex skills are not intercepted as exclusive commands and reach the model intact.
    expect(
      parseCodexCommand([{ type: 'text', text: '/$code-review Check auth and /$security-audit' }]),
    ).toBeNull()
  })

  it('marks Pi skill commands as stackable and passes multi-skill prompts through', () => {
    const list = piCommandList([
      { name: 'skill:lint', description: 'Lint code', source: 'skill' },
      { name: 'skill:audit', description: 'Audit code', source: 'skill' },
      { name: 'template', description: 'Prompt template', source: 'prompt' },
    ])
    expect(list.find((c) => c.name === 'skill:lint')?.kind).toBe('skill')
    expect(list.find((c) => c.name === 'skill:audit')?.kind).toBe('skill')
    expect(list.find((c) => c.name === 'template')?.kind).toBeUndefined()
    expect(list.find((c) => c.name === 'compact')?.kind).toBeUndefined()
    expect(parsePiCommand('/skill:lint check auth with /skill:audit')).toBeNull()
  })

  it('marks Claude skills via init skill names or command source while keeping commands exclusive', () => {
    const list = mapClaudeCommands(
      [
        { name: 'compact', description: 'Compact conversation' },
        { name: 'code-review', description: 'Review changes' },
        { name: 'security-audit', description: 'Audit security', source: 'skill' },
      ],
      new Set(),
      new Set(['code-review']),
    )
    expect(list).toEqual([
      { name: 'compact', description: 'Compact conversation' },
      { name: 'code-review', description: 'Review changes', kind: 'skill' },
      { name: 'security-audit', description: 'Audit security', kind: 'skill' },
    ])
  })

  it('discovers Claude skills on disk and in local plugins before system.init arrives', async () => {
    const root = await tempFolder('kettu-claude-disk-skills-')
    const cwd = path.join(root, 'repo')
    const home = path.join(root, 'home')
    const configDir = path.join(home, '.claude')
    const pluginDir = path.join(root, 'plugin-kettu')

    // Project skill, user skill, shared .agents skill, and local plugin skill (with plugin.json).
    await mkdir(path.join(cwd, '.claude', 'skills', 'proj-skill'), { recursive: true })
    await writeFile(
      path.join(cwd, '.claude', 'skills', 'proj-skill', 'SKILL.md'),
      '---\nname: project-audit\ndescription: Audit repo\n---\n',
    )
    await mkdir(path.join(configDir, 'skills', 'user-skill'), { recursive: true })
    await writeFile(
      path.join(configDir, 'skills', 'user-skill', 'SKILL.md'),
      '---\nname: user-helper\ndescription: Help user\n---\n',
    )
    await mkdir(path.join(home, '.agents', 'skills', 'shared-skill'), { recursive: true })
    await writeFile(
      path.join(home, '.agents', 'skills', 'shared-skill', 'SKILL.md'),
      '---\nname: frontend-design\ndescription: Design UI\n---\n',
    )
    await mkdir(path.join(pluginDir, '.claude-plugin'), { recursive: true })
    await writeFile(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'kettu', version: '1.0.0' }),
    )
    await mkdir(path.join(pluginDir, 'skills', 'market-skill'), { recursive: true })
    await writeFile(
      path.join(pluginDir, 'skills', 'market-skill', 'SKILL.md'),
      '---\nname: market-lint\ndescription: Market lint\n---\n',
    )

    const discovered = await scanClaudeSkillsOnDisk(cwd, home, configDir, [pluginDir])
    const mapped = mapClaudeCommands(
      [
        { name: 'compact', description: 'Compact conversation' },
        { name: 'project-audit', description: 'Audit repo' },
        { name: 'user-helper', description: 'Help user' },
        { name: 'frontend-design', description: 'Design UI' },
        { name: 'kettu:market-lint', description: 'Market lint' },
      ],
      new Set(),
      discovered,
    )

    expect(mapped).toEqual([
      { name: 'compact', description: 'Compact conversation' },
      { name: 'project-audit', description: 'Audit repo', kind: 'skill' },
      { name: 'user-helper', description: 'Help user', kind: 'skill' },
      { name: 'frontend-design', description: 'Design UI', kind: 'skill' },
      { name: 'kettu:market-lint', description: 'Market lint', kind: 'skill' },
    ])
  })

  it('marks ACP skills via _meta or known skill set while keeping commands exclusive', () => {
    const list = mapAcpCommands(
      [
        { name: 'compact', description: 'Compact' },
        { name: 'code-review', description: 'Review', _meta: { kind: 'skill' } },
        { name: 'security-audit', description: 'Audit' },
      ],
      new Set(['security-audit']),
    )
    expect(list).toEqual([
      { name: 'compact', description: 'Compact' },
      { name: 'code-review', description: 'Review', kind: 'skill' },
      { name: 'security-audit', description: 'Audit', kind: 'skill' },
    ])
  })

  it('preserves stacked skills cleanly in OpenCode and generic prompt payloads', () => {
    const text = '/code-review Inspect auth and apply /security-audit checks'
    expect(promptBlocks([{ type: 'text', text }])).toEqual([{ type: 'text', text }])
    // Leading skill still triggers OpenCode /command while preserving stacked skills in args.
    expect(parseOpenCodeCommand(text)).toEqual({
      name: 'code-review',
      text: 'Inspect auth and apply /security-audit checks',
    })
    // Inline-only skills stay a normal prompt.
    expect(parseOpenCodeCommand('Use /code-review and /security-audit')).toBeNull()
  })

  it('formats read_skill notices for one or multiple selected skills', () => {
    expect(skillNotice(['code-review'])).toContain('read_skill')
    expect(skillNotice(['code-review'])).toContain('"code-review"')
    expect(skillNotice(['code-review', 'security-audit'])).toContain(
      '"code-review", "security-audit"',
    )
  })
})

describe('read_skill routing with multiple skills in one message', () => {
  const SKILL_A: MarketSkill = {
    id: 'local:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'code-review',
    description: 'Review code changes',
    source: 'local',
    origin: '/skills/code-review',
    version: null,
    agents: ['fake-agent'],
    on: true,
  }
  const SKILL_B: MarketSkill = {
    id: 'local:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    name: 'security-audit',
    description: 'Audit security issues',
    source: 'local',
    origin: '/skills/security-audit',
    version: null,
    agents: ['fake-agent'],
    on: true,
  }

  it('exposes installed read_skill skills as stackable and preserves stacked skills on send', async () => {
    const dataDir = await tempFolder('kettu-multi-skills-')
    for (const skill of [SKILL_A, SKILL_B]) {
      const folder = path.join(dataDir, 'marketplace', 'skills', skillFolder(skill.id), skill.name)
      await mkdir(folder, { recursive: true })
      await writeFile(
        path.join(folder, 'SKILL.md'),
        `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\nInstructions for ${skill.name}.\n`,
      )
    }

    const host = await startTestHost({ userDataPath: dataDir })
    hosts.push(host)
    const current = (host.host as unknown as { settings: HostSettings }).settings
    await host.host.updateSettings({
      ...current,
      marketplace: { mcp: [], skills: [SKILL_A, SKILL_B] },
    })
    await (host.host as unknown as { marketSkills: { sync(): Promise<void> } }).marketSkills.sync()

    const window = host.connect()
    const { id } = await window.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: host.project,
    })
    await window.open(id)
    await window.untilStatus(id, 'ready')

    // Wait for available_commands_update from fake-agent, augmented with read_skill skills.
    await vi.waitFor(() => {
      const commands = window.thread(id).session.commands
      expect(commands.find((c) => c.name === 'code-review')?.kind).toBe('skill')
      expect(commands.find((c) => c.name === 'security-audit')?.kind).toBe('skill')
      expect(commands.find((c) => c.name === 'compact')?.kind).toBeUndefined()
    })

    const message = '/code-review Inspect auth and apply /security-audit checks'
    await window.request('sessions.queue', {
      sessionId: id,
      content: [{ type: 'text', text: message }],
    })
    await window.untilStatus(id, 'running')
    await window.untilStatus(id, 'ready')

    const entries = window.entries(id)
    const sent = entries.find((entry) => entry.kind === 'user')
    expect(sent).toMatchObject({
      content: [{ type: 'text', text: message }],
    })
    // Fake agent echoes the prompt's first line cleanly without corrupting stacked skills.
    expect(
      entries.some((entry) => entry.kind === 'agent' && entry.markdown.includes(message)),
    ).toBe(true)
  })
})
