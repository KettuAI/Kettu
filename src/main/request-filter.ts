// Electron keeps one `onBeforeRequest` listener per session, the last one set, so every rule that
// cancels requests goes through this one.

import type { OnBeforeRequestListenerDetails, Session } from 'electron'

/** True cancels the request. */
export type RequestRule = (details: OnBeforeRequestListenerDetails) => boolean

const rules = new WeakMap<Session, RequestRule[]>()

export function refuseRequests(session: Session, rule: RequestRule): void {
  const list = rules.get(session)
  if (list) {
    list.push(rule)
    return
  }
  const added = [rule]
  rules.set(session, added)
  session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: added.some((refuses) => refuses(details)) })
  })
}
