// Google Antigravity's ACP mode signs in with the method the last ACP client chose, which agy keeps
// in `acp-auth-state.json`. When that is an API key or a cloud project whose credentials are gone,
// agy refuses every session though it still holds a Google sign-in, which its terminal and print
// mode go on using (1.5.17). A second `agy acp` in a scratch folder, where no method is saved,
// falls back to that Google sign-in and names its plan in its answer to `session/new`; it never
// signs in or opens a browser, and refuses the session when agy holds no Google sign-in.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import type { AgentRun } from './agent-process'
import { messageStream, RpcPeer } from './codex/rpc'
import type { AgentTransport } from './driver'
import { antigravityTierSignIn } from './vendor-usage/antigravity'
import { object } from './vendor-usage/common'

const TIMEOUT_MS = 30_000

export type GoogleSignIn = 'oauth-personal' | 'oauth-business'

type CheckRun = AgentRun & { readonly transport: AgentTransport }

export interface SignInCheck {
  /** Starts the user's `agy acp` with its folder in `folder`. */
  launch(folder: string): CheckRun
  /** A folder of Kettu's own, where the scratch folder is made and removed. */
  parent: string
  timeoutMs?: number
}

/**
 * The Google sign-in the user's agy holds, by the plan a scratch `agy acp` names; null when it
 * refused the session, named no plan Kettu knows, failed or gave no answer in time. The process
 * is stopped and its folder removed either way.
 */
export async function savedGoogleSignIn(check: SignInCheck): Promise<GoogleSignIn | null> {
  await mkdir(check.parent, { recursive: true })
  const folder = await mkdtemp(path.join(check.parent, 'agy-sign-in-'))
  let run: CheckRun | null = null
  let rpc: RpcPeer | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    run = check.launch(folder)
    const { stream, close } = messageStream(run.transport)
    const peer = new RpcPeer(
      stream,
      {
        notification: () => {},
        request: () => Promise.reject(new Error('The sign-in check answers no request')),
        traffic: () => {},
        log: () => {},
      },
      close,
    )
    rpc = peer
    void run.exited.then(() => peer.close())
    const ask = async (): Promise<GoogleSignIn | null> => {
      await peer.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      })
      const opened = await peer.request('session/new', { cwd: folder, mcpServers: [] })
      return antigravityTierSignIn(object(opened)?._meta)
    }
    return await Promise.race([
      ask(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), check.timeoutMs ?? TIMEOUT_MS)
      }),
    ])
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
    rpc?.close()
    // agy writes to its folder until it exits.
    await run?.stop()
    await rm(folder, { recursive: true, force: true }).catch(() => {})
  }
}
