import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { KILO } from '../agents/kilo'
import type { HostedContext, HostedSpawnOptions } from '../driver'
import { ACP_FOLDERS_DRIVER } from './driver'

function fakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as ChildProcess
}

describe("Kilo Code's folder config", () => {
  it('stays off for every session of the process the host starts first', () => {
    const spawned: HostedSpawnOptions[] = []
    const context = {
      def: KILO,
      hooks: { traffic: () => {}, account: () => {}, ignored: () => {}, log: () => {} },
      spec: { command: '/bin/kilo', args: ['acp'], env: {}, shell: false, display: {} },
      env: { PATH: '/usr/bin', OPENAI_API_KEY: 'sk-test' },
      folderConfigOff: KILO.folderConfigOff,
      spawn: (options: HostedSpawnOptions) => {
        spawned.push(options)
        return fakeChild()
      },
    } as unknown as HostedContext
    const connection = ACP_FOLDERS_DRIVER.connect(context)
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.args).toEqual(['acp'])
    expect(spawned[0]!.env).toMatchObject({
      KILO_DISABLE_PROJECT_CONFIG: '1',
      OPENAI_API_KEY: 'sk-test',
    })
    connection.close()
  })
})
