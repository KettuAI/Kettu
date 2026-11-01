// A stand-in for ssh in tests, run with node: it reads its arguments as ssh would and plays the
// machine the target names. A command runs in `sh -s` with HOME set to FAKE_SSH_HOME and that
// home's bin first on the PATH, as a login there would; `-W host:port` connects to that port on
// this computer. A target whose user is a failure's name fails as ssh does: auth, unknown,
// changed, down; noforward refuses -W, and windows runs no sh. Each run appends its arguments and
// pid to FAKE_SSH_LOG as a line of JSON.

import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { connect } from 'node:net'
import path from 'node:path'

const WITH_VALUE = new Set(['-o', '-W', '-F', '-i', '-p', '-l', '-J', '-b', '-c', '-m', '-E'])

const argv = process.argv.slice(2)
let forward: string | null = null
let index = 0
for (; index < argv.length; index++) {
  const arg = argv[index]!
  if (arg === '--') {
    index++
    break
  }
  if (!arg.startsWith('-')) break
  if (WITH_VALUE.has(arg)) {
    if (arg === '-W') forward = argv[index + 1] ?? null
    index++
  }
}
const target = argv[index] ?? ''
const command = argv.slice(index + 1)
const user = target.includes('@') ? target.slice(0, target.indexOf('@')) : ''
const host = target.slice(target.indexOf('@') + 1)

if (process.env.FAKE_SSH_LOG) {
  const line = { pid: process.pid, args: argv, target, forward, command }
  appendFileSync(process.env.FAKE_SSH_LOG, `${JSON.stringify(line)}\n`)
}

function fail(message: string, code = 255): never {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

switch (user) {
  case 'auth':
    fail(`${target}: Permission denied (publickey).`)
    break
  case 'unknown':
    fail('Host key verification failed.')
    break
  case 'changed':
    fail(
      [
        '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
        '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
        '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
        `Host key for ${host} has changed and you have requested strict checking.`,
        'Host key verification failed.',
      ].join('\n'),
    )
    break
  case 'down':
    fail(`ssh: connect to host ${host} port 22: Connection refused`)
    break
}

if (forward) {
  if (user === 'noforward') {
    fail(
      'channel 0: open failed: administratively prohibited: open failed\nstdio forwarding failed',
    )
  }
  const at = forward.lastIndexOf(':')
  const socket = connect({ host: forward.slice(0, at), port: Number(forward.slice(at + 1)) })
  socket.once('error', () => {
    fail('channel 0: open failed: connect failed: Connection refused\nstdio forwarding failed')
  })
  socket.once('connect', () => {
    process.stdin.pipe(socket)
    socket.pipe(process.stdout)
    socket.once('close', () => process.exit(0))
  })
} else if (user === 'windows') {
  fail("'sh' is not recognized as an internal or external command,", 1)
} else if (command.join(' ') !== 'sh -s') {
  fail(`fake ssh runs only sh -s, not ${command.join(' ')}`, 1)
} else {
  const home = process.env.FAKE_SSH_HOME ?? ''
  const child = spawn('sh', ['-s'], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${path.join(home, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  })
  // Through this process alone, so its end ends the output, as ssh's does.
  process.stdin.pipe(child.stdin)
  child.stdout.pipe(process.stdout)
  child.stderr.pipe(process.stderr)
  // Ends by the signal, as ssh does.
  process.once('SIGTERM', () => {
    child.kill('SIGKILL')
    process.kill(process.pid, 'SIGTERM')
  })
  child.once('close', (code) => process.exit(code ?? 1))
}
