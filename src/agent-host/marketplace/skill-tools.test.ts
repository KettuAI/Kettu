import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Caller } from '../artifacts/tools'
import {
  LIST_SKILLS,
  READ_SKILL,
  SkillTools,
  skillRoute,
  takesSkills,
  type SessionSkill,
} from './skill-tools'

describe('how an agent gets its skills', () => {
  it('is a folder for the harnesses that load one and the tools for every other', () => {
    for (const agent of ['claude-code', 'codex', 'opencode', 'pi', 'pi~work'] as const) {
      expect(skillRoute(agent)).toBe('folder')
    }
    for (const agent of ['cline', 'deepseek', 'gemini', 'antigravity', 'kimi'] as const) {
      expect(skillRoute(agent)).toBe('tools')
    }
  })

  it("needs Kettu's server only where the tools carry the skills", () => {
    expect(takesSkills('codex', false)).toBe(true)
    expect(takesSkills('pi', false)).toBe(true)
    expect(takesSkills('cline', true)).toBe(true)
    expect(takesSkills('cline', false)).toBe(false)
  })
})

describe('the skill tools', () => {
  let root: string
  let given: Map<string, SessionSkill[] | null>
  let tools: SkillTools
  const caller = (sessionId: string): Caller => ({ sessionId, project: '/project' })

  async function skill(name: string, text = `---\nname: ${name}\n---\n\nUse ${name}.\n`) {
    const dir = path.join(root, `${name}-0123`, name)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'SKILL.md'), text)
    return { name, description: `When to use ${name}.`, dir }
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'kettu-skill-tools-'))
    given = new Map()
    tools = new SkillTools({ of: (sessionId) => given.get(sessionId) ?? null })
    given.set('one', [await skill('pdf')])
    given.set('two', [await skill('docx')])
    given.set('none', [])
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("list only the calling session's skills, without their folders", async () => {
    const result = await tools.call(caller('one'), LIST_SKILLS, {})
    expect(result.structuredContent).toEqual({
      skills: [{ name: 'pdf', description: 'When to use pdf.' }],
    })
    expect(JSON.stringify(result)).not.toContain('docx')
    const empty = await tools.call(caller('none'), LIST_SKILLS, undefined)
    expect(empty.structuredContent).toEqual({ skills: [] })
  })

  it('read a skill with the folder it sits in', async () => {
    const result = await tools.call(caller('one'), READ_SKILL, { name: 'pdf' })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({
      name: 'pdf',
      folder: path.join(root, 'pdf-0123', 'pdf'),
      text: '---\nname: pdf\n---\n\nUse pdf.\n',
    })
  })

  it('refuse a skill of another session, an unknown name and a name that is a path', async () => {
    await writeFile(path.join(root, 'SKILL.md'), 'outside')
    const names = ['docx', 'nope', '', '..', '../..', '../docx-0123/docx', path.join(root), 7, null]
    for (const name of names) {
      const result = await tools.call(caller('one'), READ_SKILL, { name })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result)).not.toContain('Use docx')
      expect(JSON.stringify(result)).not.toContain('outside')
    }
    expect((await tools.call(caller('one'), READ_SKILL, {})).isError).toBe(true)
    expect((await tools.call(caller('one'), READ_SKILL, { name: 'pdf', path: 'x' })).isError).toBe(
      true,
    )
  })

  it('refuse a kept skill whose name or folder would leave its own folder', async () => {
    await writeFile(path.join(root, 'SKILL.md'), 'outside')
    given.set('bad', [
      { name: '..', description: 'd', dir: path.join(root, 'pdf-0123', '..') },
      { name: 'pdf', description: 'd', dir: root },
    ])
    for (const name of ['..', 'pdf']) {
      const result = await tools.call(caller('bad'), READ_SKILL, { name })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result)).not.toContain('outside')
    }
  })

  it('refuse a SKILL.md that is a link', async () => {
    const secret = path.join(root, 'secret')
    await writeFile(secret, 'outside')
    const dir = path.join(root, 'link-0123', 'link')
    await mkdir(dir, { recursive: true })
    await symlink(secret, path.join(dir, 'SKILL.md'))
    given.set('link', [{ name: 'link', description: 'd', dir }])
    const result = await tools.call(caller('link'), READ_SKILL, { name: 'link' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain('outside')
  })

  it('are not for a session whose agent loads skill folders itself', async () => {
    expect(tools.listed('one')).toBe(true)
    expect(tools.listed('folder-agent')).toBe(false)
    expect((await tools.call(caller('folder-agent'), LIST_SKILLS, {})).isError).toBe(true)
  })
})
