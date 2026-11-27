// A sign-in asked for from outside the Marketplace, such as the line under a server an agent
// added: the server's page opens, and its Sign in starts the sign-in once, in its own popover,
// which shows the browser step or the device code.

import { create } from 'zustand'

interface SignInRequest {
  hostId: string | null
  serverId: string
  at: number
}

/** How long a request waits for the page to take it, so a later visit starts nothing unasked. */
const REQUEST_MS = 30_000

const useSignInRequests = create<{ request: SignInRequest | null }>(() => ({ request: null }))

function matches(request: SignInRequest | null, hostId: string | null, serverId: string): boolean {
  return (
    request !== null &&
    request.hostId === hostId &&
    request.serverId === serverId &&
    Date.now() - request.at < REQUEST_MS
  )
}

export function requestSignIn(hostId: string | null, serverId: string): void {
  useSignInRequests.setState({ request: { hostId, serverId, at: Date.now() } })
}

/** Whether a sign-in waits for this server on this host now. */
export function signInRequested(hostId: string | null, serverId: string): boolean {
  return matches(useSignInRequests.getState().request, hostId, serverId)
}

/** Takes the request, so that it starts one sign-in only. */
export function takeSignInRequest(hostId: string | null, serverId: string): boolean {
  const { request } = useSignInRequests.getState()
  if (!request || request.hostId !== hostId || request.serverId !== serverId) return false
  useSignInRequests.setState({ request: null })
  return matches(request, hostId, serverId)
}

/** Runs `run` when a sign-in is asked for this server while its page shows; gives the unsubscribe. */
export function onSignInRequest(
  hostId: string | null,
  serverId: string,
  run: () => void,
): () => void {
  return useSignInRequests.subscribe((s) => {
    if (matches(s.request, hostId, serverId)) run()
  })
}
