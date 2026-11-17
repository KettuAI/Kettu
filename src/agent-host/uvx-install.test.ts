import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectAgent, type AgentDefinition, type DetectContext } from './catalog'
import type { VersionChoice } from './harness-versions'
import { tempFolder } from './testing/temp'
import { UVX_FILE, writeUvxVersion } from './uvx-install'

const def: AgentDefinition = {
  id: 'fast-agent',
  name: 'fast-agent',
  registryId: 'fast-agent',
  launch: { kind: 'uvx', package: 'fast-agent-acp', args: ['-x'] },
  install: { hint: 'detect.hint.uv', url: 'https://docs.astral.sh/uv/' },
}

const context = (adaptersDir: string, versions: VersionChoice): DetectContext => ({
  platform: 'linux',
  env: { PATH: '/usr/bin' },
  nodeRuntime: { command: '/usr/bin/node', env: {} },
  binaryOverride: null,
  node: { nodeVersion: null, npmPath: null, nodePath: null },
  adaptersDir,
  versions,
  isExecutable: async (file) => file === '/usr/bin/uvx',
})

describe('the uvx version a start runs', () => {
  it('runs the wanted version until another is fetched, then the one uv fetched', async () => {
    const root = await tempFolder('kettu-uvx-')
    expect(await detectAgent(def, context(root, { wanted: '0.10.1' }))).toMatchObject({
      spec: { command: '/usr/bin/uvx', args: ['fast-agent-acp==0.10.1', '-x'] },
      release: { version: '0.10.1', dir: null },
    })
    await writeUvxVersion(root, 'fast-agent', '0.10.2')
    expect(await detectAgent(def, context(root, { wanted: '0.10.2' }))).toMatchObject({
      spec: {
        args: ['fast-agent-acp==0.10.2', '-x'],
        display: { args: ['fast-agent-acp==0.10.2', '-x'] },
        version: '0.10.2',
      },
      release: { version: '0.10.2' },
    })
  })

  it('runs the version that ran before when the one fetched failed to start', async () => {
    const root = await tempFolder('kettu-uvx-')
    await writeUvxVersion(root, 'fast-agent', '0.10.2')
    const choice = { wanted: '0.10.2', ran: '0.10.0', failed: '0.10.2' }
    expect(await detectAgent(def, context(root, choice))).toMatchObject({
      spec: { args: ['fast-agent-acp==0.10.0', '-x'] },
    })
  })

  it('ignores a record that is not a plain version', async () => {
    const root = await tempFolder('kettu-uvx-')
    await mkdir(path.join(root, 'fast-agent'), { recursive: true })
    await writeFile(
      path.join(root, 'fast-agent', UVX_FILE),
      JSON.stringify({ version: '9.0.0 --with evil' }),
    )
    expect(await detectAgent(def, context(root, { wanted: '0.10.1' }))).toMatchObject({
      spec: { args: ['fast-agent-acp==0.10.1', '-x'] },
    })
    await expect(writeUvxVersion(root, 'fast-agent', '9.0.0; rm -rf ~')).rejects.toThrow()
  })
})
