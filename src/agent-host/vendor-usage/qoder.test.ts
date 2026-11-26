import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseQoderUsage, readQoderUsage } from './qoder'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-qoder-test-'))
  tempDirs.push(dir)
  return dir
}

function nodeArgs(script: string): string[] {
  return ['-e', script]
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('Qoder usage reply', () => {
  it('maps recorded credits and add-on packs', () => {
    const result = parseQoderUsage(
      {
        accountUsage: {
          totalUsagePercentage: 10,
          userQuota: { used: 10, total: 100, remaining: 90, unit: 'credits' },
          addOnQuota: { used: 2, total: 10, remaining: 8, unit: 'credits' },
        },
      },
      10,
    )
    expect(result?.limits[0].amount).toEqual({ used: 10, total: 100, unit: 'credits' })
    expect(result?.balances[0].amount).toBe(8)
  })

  it('maps daemon.get_usage_info NDJSON payload under usage', () => {
    const result = parseQoderUsage(
      {
        usage: {
          totalUsagePercentage: 1.4,
          userQuota: { used: 42, total: 3000, remaining: 2958, unit: 'credits' },
          addOnQuota: { used: 0, total: 50, remaining: 50, unit: 'credits' },
        },
        session: { total_credits: 0, model_usage: {} },
      },
      123,
    )
    expect(result?.limits[0]).toMatchObject({
      window: 'monthly',
      label: 'Monthly',
      usedPercent: expect.closeTo(1.4, 10),
      state: 'ok',
      observedAt: 123,
      amount: { used: 42, total: 3000, unit: 'credits' },
    })
    expect(result?.balances).toEqual([{ label: 'Add-on credits', amount: 50, currency: 'credits' }])
  })

  it('derives used credits from total and remaining when used is absent', () => {
    const result = parseQoderUsage(
      {
        usage: {
          userQuota: { total: 1000, remaining: 750, unit: 'credits' },
        },
      },
      50,
    )
    expect(result?.limits[0].amount).toEqual({ used: 250, total: 1000, unit: 'credits' })
  })

  it('returns null when usage is absent or total is non-positive', () => {
    expect(parseQoderUsage({ usage: null, session: { total_credits: 0 } }, 10)).toBeNull()
    expect(parseQoderUsage({ usage: { userQuota: { used: 0, total: 0 } } }, 10)).toBeNull()
  })
})

describe('readQoderUsage', () => {
  it('reads usage over NDJSON control frames with qodercli auth in initialize', async () => {
    const dir = makeTempDir()
    const logPath = path.join(dir, 'frames.log')
    const script = `
      const fs = require('node:fs');
      let buf = '';
      process.stdin.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        for (let nl = buf.indexOf('\\n'); nl >= 0; nl = buf.indexOf('\\n')) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          fs.appendFileSync(process.env.LOG_PATH, line + '\\n');
          const frame = JSON.parse(line);
          const method = frame.request?.type ?? frame.request?.subtype;
          if (method === 'daemon.initialize') {
            process.stdout.write(JSON.stringify({
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: frame.request_id,
                response: {
                  daemon_protocol_version: 2,
                  daemon_version: '1.1.98',
                  capabilities: ['multi_session_v2', 'daemon_queries_v1'],
                },
              },
            }) + '\\n');
          } else if (method === 'daemon.get_usage_info') {
            process.stdout.write(JSON.stringify({
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: frame.request_id,
                response: {
                  usage: {
                    userQuota: { used: 42, total: 3000, remaining: 2958, unit: 'credits' },
                    addOnQuota: { remaining: 12 },
                  },
                  session: { total_credits: 0, model_usage: {} },
                },
              },
            }) + '\\n');
          }
        }
      });
    `

    const usage = await readQoderUsage(
      process.execPath,
      nodeArgs(script),
      { ...process.env, LOG_PATH: logPath },
      1000,
    )

    expect(usage?.limits[0]).toMatchObject({
      window: 'monthly',
      label: 'Monthly',
      usedPercent: expect.closeTo(1.4, 10),
      state: 'ok',
      observedAt: 1000,
      amount: { used: 42, total: 3000, unit: 'credits' },
    })
    expect(usage?.balances).toEqual([{ label: 'Add-on credits', amount: 12, currency: 'credits' }])

    const sent = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(sent).toEqual([
      {
        type: 'control_request',
        request_id: '1',
        request: {
          type: 'daemon.initialize',
          daemon_protocol_version: 2,
          sdk_version: '0.1.0',
          capabilities: ['multi_session_v2', 'daemon_queries_v1'],
          auth: { type: 'qodercli' },
        },
      },
      {
        type: 'control_request',
        request_id: '2',
        request: {
          type: 'daemon.get_usage_info',
        },
      },
    ])
  })

  it('calls daemon.authenticate and retries when get_usage_info reports missing credentials', async () => {
    const dir = makeTempDir()
    const logPath = path.join(dir, 'frames.log')
    const script = `
      const fs = require('node:fs');
      let buf = '';
      let authed = false;
      process.stdin.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        for (let nl = buf.indexOf('\\n'); nl >= 0; nl = buf.indexOf('\\n')) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          fs.appendFileSync(process.env.LOG_PATH, line + '\\n');
          const frame = JSON.parse(line);
          const method = frame.request?.type ?? frame.request?.subtype;
          if (method === 'daemon.initialize') {
            process.stdout.write(JSON.stringify({
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: frame.request_id,
                response: { daemon_protocol_version: 2, daemon_version: '1.1.98', capabilities: ['multi_session_v2'] },
              },
            }) + '\\n');
          } else if (method === 'daemon.get_usage_info' && !authed) {
            process.stdout.write(JSON.stringify({
              type: 'control_response',
              response: {
                subtype: 'error',
                request_id: frame.request_id,
                code: 'DAEMON_COMMAND_FAILED',
                error: 'daemon has no credentials; pass an authPayload to daemon.auth() or provide auth to startDaemon',
              },
            }) + '\\n');
          } else if (method === 'daemon.authenticate') {
            authed = frame.request?.auth?.type === 'qodercli';
            process.stdout.write(JSON.stringify({
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: frame.request_id,
                response: { authenticated: authed },
              },
            }) + '\\n');
          } else if (method === 'daemon.get_usage_info' && authed) {
            process.stdout.write(JSON.stringify({
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: frame.request_id,
                response: {
                  usage: { userQuota: { used: 15, total: 500, unit: 'credits' } },
                  session: { total_credits: 0, model_usage: {} },
                },
              },
            }) + '\\n');
          }
        }
      });
    `

    const usage = await readQoderUsage(
      process.execPath,
      nodeArgs(script),
      { ...process.env, LOG_PATH: logPath },
      2000,
    )

    expect(usage?.limits[0].amount).toEqual({ used: 15, total: 500, unit: 'credits' })
    const methods = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).request.type)
    expect(methods).toEqual([
      'daemon.initialize',
      'daemon.get_usage_info',
      'daemon.authenticate',
      'daemon.get_usage_info',
    ])
  })

  it('rejects when explicit daemon.authenticate reports authenticated: false', async () => {
    const script = `
      let buf = '';
      process.stdin.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        for (let nl = buf.indexOf('\\n'); nl >= 0; nl = buf.indexOf('\\n')) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const frame = JSON.parse(line);
          const method = frame.request?.type;
          if (method === 'daemon.initialize') {
            process.stdout.write(JSON.stringify({
              type: 'control_response',
              response: { subtype: 'success', request_id: frame.request_id, response: { daemon_protocol_version: 2 } },
            }) + '\\n');
          } else if (method === 'daemon.get_usage_info') {
            process.stdout.write(JSON.stringify({
              type: 'control_response',
              response: { subtype: 'error', request_id: frame.request_id, code: 'AUTH_PAYLOAD_REQUIRED', error: 'daemon has no credentials' },
            }) + '\\n');
          } else if (method === 'daemon.authenticate') {
            process.stdout.write(JSON.stringify({
              type: 'control_response',
              response: { subtype: 'success', request_id: frame.request_id, response: { authenticated: false } },
            }) + '\\n');
          }
        }
      });
    `

    await expect(
      readQoderUsage(process.execPath, nodeArgs(script), process.env, 10),
    ).rejects.toThrow('daemon has no credentials')
  })

  it('handles partial UTF-8 chunks, CRLF, interleaved frames, and EOF without trailing newline', async () => {
    const script = `
      let buf = '';
      function writeChunked(text, delayMs, done) {
        const bytes = Buffer.from(text, 'utf8');
        let offset = 0;
        const step = () => {
          if (offset >= bytes.length) { done?.(); return; }
          const end = Math.min(bytes.length, offset + 5);
          process.stdout.write(bytes.subarray(offset, end));
          offset = end;
          setTimeout(step, delayMs);
        };
        step();
      }
      process.stdin.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        for (let nl = buf.indexOf('\\n'); nl >= 0; nl = buf.indexOf('\\n')) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const frame = JSON.parse(line);
          if (frame.request.type === 'daemon.initialize') {
            const payload =
              '\\r\\n' +
              JSON.stringify({ type: 'keep_alive' }) + '\\r\\n' +
              JSON.stringify({ type: 'status_event', status: 'daemon.mcp_server_updated', data: {} }) + '\\r\\n' +
              JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'other', response: {} } }) + '\\r\\n' +
              JSON.stringify({
                type: 'control_response',
                response: { subtype: 'success', request_id: frame.request_id, response: { daemon_protocol_version: 2, note: 'multi-byte \\u00e9\\u2014\\u2605 split' } },
              }) + '\\r\\n';
            writeChunked(payload, 2);
          } else if (frame.request.type === 'daemon.get_usage_info') {
            const finalLine = JSON.stringify({
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: frame.request_id,
                response: {
                  usage: {
                    plan: 'Pro \\u2014 Plus',
                    userQuota: { used: 20, total: 200, unit: 'credits' },
                  },
                  session: { total_credits: 0, model_usage: {} },
                },
              },
            });
            writeChunked(finalLine, 2, () => process.exit(0));
          }
        }
      });
    `

    const usage = await readQoderUsage(process.execPath, nodeArgs(script), process.env, 500)
    expect(usage?.tier).toBe('Pro \u2014 Plus')
    expect(usage?.limits[0].amount).toEqual({ used: 20, total: 200, unit: 'credits' })
  })

  it('surfaces daemon error responses and usage_error without falling back after handshake', async () => {
    const dir = makeTempDir()
    const countPath = path.join(dir, 'spawns.txt')
    const rpcErrorScript = `
      const fs = require('node:fs');
      fs.appendFileSync(process.env.COUNT_PATH, '1\\n');
      let buf = '';
      process.stdin.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        for (let nl = buf.indexOf('\\n'); nl >= 0; nl = buf.indexOf('\\n')) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const frame = JSON.parse(line);
          if (frame.request.type === 'daemon.initialize') {
            process.stdout.write(JSON.stringify({
              type: 'control_response',
              response: { subtype: 'success', request_id: frame.request_id, response: { daemon_protocol_version: 2 } },
            }) + '\\n');
          } else if (frame.request.type === 'daemon.get_usage_info') {
            process.stdout.write(JSON.stringify({
              type: 'control_response',
              response: { subtype: 'error', request_id: frame.request_id, code: 'DAEMON_COMMAND_FAILED', error: 'account not signed in' },
            }) + '\\n');
          }
        }
      });
    `

    await expect(
      readQoderUsage(
        process.execPath,
        nodeArgs(rpcErrorScript),
        { ...process.env, COUNT_PATH: countPath },
        10,
      ),
    ).rejects.toThrow('account not signed in')
    expect(readFileSync(countPath, 'utf8').trim().split('\n')).toHaveLength(1)

    const usageErrorScript = `
      let buf = '';
      process.stdin.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        for (let nl = buf.indexOf('\\n'); nl >= 0; nl = buf.indexOf('\\n')) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const frame = JSON.parse(line);
          if (frame.request.type === 'daemon.initialize') {
            process.stdout.write(JSON.stringify({
              type: 'control_response',
              response: { subtype: 'success', request_id: frame.request_id, response: { daemon_protocol_version: 2 } },
            }) + '\\n');
          } else if (frame.request.type === 'daemon.get_usage_info') {
            process.stdout.write(JSON.stringify({
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: frame.request_id,
                response: { usage: null, session: { total_credits: 0, model_usage: {} }, usage_error: 'quota endpoint returned 503' },
              },
            }) + '\\n');
          }
        }
      });
    `

    await expect(
      readQoderUsage(process.execPath, nodeArgs(usageErrorScript), process.env, 10),
    ).rejects.toThrow('quota endpoint returned 503')
  })

  it('rejects on protocol_error frame after handshake', async () => {
    const script = `
      let buf = '';
      process.stdin.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        for (let nl = buf.indexOf('\\n'); nl >= 0; nl = buf.indexOf('\\n')) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const frame = JSON.parse(line);
          if (frame.request.type === 'daemon.initialize') {
            process.stdout.write(JSON.stringify({
              type: 'control_response',
              response: { subtype: 'success', request_id: frame.request_id, response: { daemon_protocol_version: 2 } },
            }) + '\\n');
          } else if (frame.request.type === 'daemon.get_usage_info') {
            process.stdout.write(JSON.stringify({
              type: 'protocol_error',
              code: 'MALFORMED_NDJSON_INPUT',
              message: 'stream framing lost',
            }) + '\\n');
          }
        }
      });
    `

    await expect(
      readQoderUsage(process.execPath, nodeArgs(script), process.env, 10),
    ).rejects.toThrow('stream framing lost')
  })

  it('falls back immediately to legacy Content-Length JSON-RPC when server rejects NDJSON', async () => {
    const script = `
      let buf = Buffer.alloc(0);
      function writeRpc(msg) {
        const body = Buffer.from(JSON.stringify(msg));
        process.stdout.write('Content-Length: ' + body.byteLength + '\\r\\n\\r\\n');
        process.stdout.write(body);
      }
      process.stdin.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!buf.toString('ascii').startsWith('Content-Length:')) {
          writeRpc({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Expected Content-Length header' } });
          process.exit(1);
        }
        while (true) {
          const boundary = buf.indexOf('\\r\\n\\r\\n');
          if (boundary < 0) return;
          const header = buf.subarray(0, boundary).toString('ascii');
          const length = Number(/content-length:\\s*(\\d+)/i.exec(header)[1]);
          if (buf.length < boundary + 4 + length) return;
          const req = JSON.parse(buf.subarray(boundary + 4, boundary + 4 + length).toString('utf8'));
          buf = buf.subarray(boundary + 4 + length);
          if (req.method === 'daemon.initialize') {
            writeRpc({ jsonrpc: '2.0', id: req.id, result: { ok: true } });
          } else if (req.method === 'daemon.get_usage_info') {
            writeRpc({
              jsonrpc: '2.0',
              id: req.id,
              result: {
                accountUsage: {
                  userQuota: { used: 30, total: 300, unit: 'credits' },
                },
              },
            });
          }
        }
      });
    `

    const usage = await readQoderUsage(process.execPath, nodeArgs(script), process.env, 3000)
    expect(usage?.limits[0].amount).toEqual({ used: 30, total: 300, unit: 'credits' })
  })

  it('falls back to legacy Content-Length JSON-RPC when a silent legacy server waits for CRLF headers', async () => {
    const script = `
      let buf = Buffer.alloc(0);
      function writeRpc(msg) {
        const body = Buffer.from(JSON.stringify(msg));
        process.stdout.write('Content-Length: ' + body.byteLength + '\\r\\n\\r\\n');
        process.stdout.write(body);
      }
      process.stdin.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (true) {
          const boundary = buf.indexOf('\\r\\n\\r\\n');
          if (boundary < 0) return;
          const header = buf.subarray(0, boundary).toString('ascii');
          const match = /content-length:\\s*(\\d+)/i.exec(header);
          if (!match) return;
          const length = Number(match[1]);
          if (buf.length < boundary + 4 + length) return;
          const req = JSON.parse(buf.subarray(boundary + 4, boundary + 4 + length).toString('utf8'));
          buf = buf.subarray(boundary + 4 + length);
          if (req.method === 'daemon.initialize') {
            writeRpc({ jsonrpc: '2.0', id: req.id, result: { ok: true } });
          } else if (req.method === 'daemon.get_usage_info') {
            writeRpc({
              jsonrpc: '2.0',
              id: req.id,
              result: {
                accountUsage: {
                  userQuota: { used: 7, total: 70, unit: 'credits' },
                },
              },
            });
          }
        }
      });
    `

    const usage = await readQoderUsage(process.execPath, nodeArgs(script), process.env, 4000, 1000)
    expect(usage?.limits[0].amount).toEqual({ used: 7, total: 70, unit: 'credits' })
  })

  it('times out cleanly when the daemon never responds', async () => {
    const script = `setInterval(() => {}, 60_000);`
    await expect(
      readQoderUsage(process.execPath, nodeArgs(script), process.env, 10, 250),
    ).rejects.toThrow('Vendor RPC timed out')
  })

  it('times out cleanly when get_usage_info hangs after a successful handshake', async () => {
    const script = `
      let buf = '';
      process.stdin.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        for (let nl = buf.indexOf('\\n'); nl >= 0; nl = buf.indexOf('\\n')) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const frame = JSON.parse(line);
          if (frame.request.type === 'daemon.initialize') {
            process.stdout.write(JSON.stringify({
              type: 'control_response',
              response: { subtype: 'success', request_id: frame.request_id, response: { daemon_protocol_version: 2 } },
            }) + '\\n');
          }
        }
      });
    `

    await expect(
      readQoderUsage(process.execPath, nodeArgs(script), process.env, 10, 300),
    ).rejects.toThrow('Vendor RPC timed out')
  })

  it('rejects immediately without fallback on malformed JSON or exit after handshake', async () => {
    const dir = makeTempDir()
    const countPath = path.join(dir, 'spawns.txt')
    const malformedScript = `
      const fs = require('node:fs');
      fs.appendFileSync(process.env.COUNT_PATH, '1\\n');
      let buf = '';
      process.stdin.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        for (let nl = buf.indexOf('\\n'); nl >= 0; nl = buf.indexOf('\\n')) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const frame = JSON.parse(line);
          if (frame.request.type === 'daemon.initialize') {
            process.stdout.write(JSON.stringify({
              type: 'control_response',
              response: { subtype: 'success', request_id: frame.request_id, response: { daemon_protocol_version: 2 } },
            }) + '\\n');
          } else if (frame.request.type === 'daemon.get_usage_info') {
            process.stdout.write('not-valid-json\\n');
          }
        }
      });
    `

    await expect(
      readQoderUsage(
        process.execPath,
        nodeArgs(malformedScript),
        { ...process.env, COUNT_PATH: countPath },
        10,
      ),
    ).rejects.toThrow('Invalid JSON-RPC frame')
    expect(readFileSync(countPath, 'utf8').trim().split('\n')).toHaveLength(1)

    const exitScript = `
      let buf = '';
      process.stdin.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        for (let nl = buf.indexOf('\\n'); nl >= 0; nl = buf.indexOf('\\n')) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const frame = JSON.parse(line);
          if (frame.request.type === 'daemon.initialize') {
            process.stdout.write(JSON.stringify({
              type: 'control_response',
              response: { subtype: 'success', request_id: frame.request_id, response: { daemon_protocol_version: 2 } },
            }) + '\\n');
          } else if (frame.request.type === 'daemon.get_usage_info') {
            process.exit(2);
          }
        }
      });
    `

    await expect(
      readQoderUsage(process.execPath, nodeArgs(exitScript), process.env, 10),
    ).rejects.toThrow('Vendor RPC exited with code 2')
  })

  it('rejects immediately without fallback when spawning the command fails', async () => {
    await expect(
      readQoderUsage('/nonexistent-qoder-binary-kettu-test', ['--sdk'], process.env, 10, 500),
    ).rejects.toThrow()
  })
})
