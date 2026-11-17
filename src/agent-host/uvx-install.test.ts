import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectAgent, type AgentDefinition, type DetectContext } from './catalog'
import { tempFolder } from './testing/temp'
import { UVX_FILE, writeUvxVersion } from './uvx-install'

const def: AgentDefinition = {
  id: 'fast-agent',
  name: 'fast-agent',
  registryId: 'fast-agent',
  launch: { kind: 'uvx', package: 'fast-agent-acp', version: '0.10.1', args: ['-x'] },
  install: { hint: 'detect.hint.uv', url: 'https://docs.astral.sh/uv/' },
}

const context = (adaptersDir: string): DetectContext => ({
  platform: 'linux',
  env: { PATH: '/usr/bin' },
  nodeRuntime: { command: '/usr/bin/node', env: {} },
  binaryOverride: null,
  node: { nodeVersion: null, npmPath: null, nodePath: null },
  adaptersDir,
  isExecutable: async (file) => file === '/usr/bin/uvx',
})

describe('the uvx version a start runs', () => {
  it('runs the pinned version until an update is recorded, then the update', async () => {
    const root = await tempFolder('kettu-uvx-')
    expect(await detectAgent(def, context(root))).toMatchObject({
      spec: { command: '/usr/bin/uvx', args: ['fast-agent-acp==0.10.1', '-x'] },
      release: { version: '0.10.1', dir: null },
    })
    await writeUvxVersion(root, 'fast-agent', '0.10.2')
    expect(await detectAgent(def, context(root))).toMatchObject({
      spec: {
        args: ['fast-agent-acp==0.10.2', '-x'],
        display: { args: ['fast-agent-acp==0.10.2', '-x'] },
      },
      release: { version: '0.10.2' },
    })
  })

  it('runs the pin once Kettu pins a newer version than the update', async () => {
    const root = await tempFolder('kettu-uvx-')
    await writeUvxVersion(root, 'fast-agent', '0.10.0')
    expect(await detectAgent(def, context(root))).toMatchObject({
      spec: { args: ['fast-agent-acp==0.10.1', '-x'] },
    })
  })

  it('ignores a record that is not a plain version', async () => {
    const root = await tempFolder('kettu-uvx-')
    await mkdir(path.join(root, 'fast-agent'), { recursive: true })
    await writeFile(
      path.join(root, 'fast-agent', UVX_FILE),
      JSON.stringify({ version: '9.0.0 --with evil' }),
    )
    expect(await detectAgent(def, context(root))).toMatchObject({
      spec: { args: ['fast-agent-acp==0.10.1', '-x'] },
    })
    await expect(writeUvxVersion(root, 'fast-agent', '9.0.0; rm -rf ~')).rejects.toThrow()
  })
})
