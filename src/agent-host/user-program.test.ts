import { describe, expect, it } from 'vitest'
import type { InstalledCli } from '@shared/agent-host'
import { userProgramFound, type AgentDefinition, type Detection, type LaunchSpec } from './catalog'

const KETTU = '/home/me/.kettu/harnesses'
const binary = { launch: { kind: 'binary' } } as AgentDefinition
const adapter = { launch: { kind: 'package' } } as AgentDefinition

const spec = (command: string): LaunchSpec => ({
  command,
  args: [],
  env: {},
  shell: false,
  display: { command, args: [], env: {} },
})

const cli = (problem: InstalledCli['problem'] = null): InstalledCli => ({
  path: '/usr/local/bin/claude',
  version: '2.0.0',
  variable: null,
  problem,
})

describe('the user program a first start counts', () => {
  it('counts the user CLI, even one too old to run', () => {
    const tooOld: Detection = {
      state: 'not-installed',
      detail: 'too old',
      cli: cli({ kind: 'too-old', minimum: '2.1.0' }),
    }
    expect(userProgramFound(adapter, tooOld, KETTU)).toBe(true)
  })

  it('counts the program an adapter runs', () => {
    const pi: Detection = {
      state: 'available',
      spec: null,
      adapter: null,
      requires: { program: '/usr/local/bin/pi', version: '0.81.0' },
    }
    expect(userProgramFound(adapter, pi, KETTU)).toBe(true)
  })

  it('counts a binary outside the folder Kettu installs into', () => {
    const found: Detection = {
      state: 'available',
      spec: spec('/usr/local/bin/opencode'),
      adapter: null,
    }
    expect(userProgramFound(binary, found, KETTU)).toBe(true)
  })

  it('does not count a binary Kettu installed itself', () => {
    const installed: Detection = {
      state: 'available',
      spec: spec(`${KETTU}/cursor/1.0.0/agent`),
      adapter: null,
    }
    expect(userProgramFound(binary, installed, KETTU)).toBe(false)
  })

  it('does not count a harness whose program was not found, or a package alone', () => {
    expect(userProgramFound(binary, { state: 'not-installed', detail: '' }, KETTU)).toBe(false)
    const package_: Detection = {
      state: 'available',
      spec: spec('/usr/bin/node'),
      adapter: null,
    }
    expect(userProgramFound(adapter, package_, KETTU)).toBe(false)
  })
})
