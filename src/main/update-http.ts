// Guards electron-updater's ElectronHttpExecutor against unhandled EventEmitter 'error' events
// from Electron's net.request (ClientRequest / IncomingMessage) and wires CancellationToken
// aborts through to in-flight requests, including differential blockmap range downloads.

import { AsyncLocalStorage } from 'node:async_hooks'
import type { EventEmitter } from 'node:events'
import type { RequestOptions } from 'node:http'
import type { AppUpdater, CancellationToken } from 'electron-updater'
import type { Logger } from './log'
import { errorMessage } from './update-state'

export interface UpdaterResponse extends EventEmitter {
  statusCode?: number
}

export interface UpdaterRequest extends EventEmitter {
  abort(): void
  end(data?: Buffer): void
}

export interface UpdaterDownloadCallOptions {
  onCancel?: (callback: () => void) => void
  callback: (error: Error | null) => void
  options?: {
    cancellationToken?: CancellationToken
  }
}

export interface UpdaterHttpExecutor {
  createRequest(
    options: RequestOptions,
    callback: (response: UpdaterResponse) => void,
  ): UpdaterRequest
  addErrorAndTimeoutHandlers(
    request: UpdaterRequest,
    reject: (error: Error) => void,
    timeout?: number,
  ): void
  addRedirectHandlers?(
    request: UpdaterRequest,
    options: RequestOptions,
    reject: (error: Error) => void,
    redirectCount: number,
    handler: (options: RequestOptions) => void,
  ): void
  doDownload?(
    requestOptions: RequestOptions,
    options: UpdaterDownloadCallOptions,
    redirectCount: number,
  ): void
  doApiRequest?(
    options: RequestOptions,
    cancellationToken: CancellationToken,
    requestProcessor: (request: UpdaterRequest, reject: (error: Error) => void) => void,
    redirectCount?: number,
  ): Promise<string>
}

export interface GuardableUpdater {
  httpExecutor?: UpdaterHttpExecutor | null
  downloadUpdate?: AppUpdater['downloadUpdate']
}

interface RequestState {
  reject: ((error: Error) => void) | null
  requestErrorHandlerAttached: boolean
  pendingError: Error | null
  settled: boolean
  superseded: boolean
  closed: boolean
  cleanupCancel: (() => void) | null
}

const guardedExecutors = new WeakSet<object>()
const activeCancellation = new AsyncLocalStorage<CancellationToken>()

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function cleanupCancel(state: RequestState): void {
  const cleanup = state.cleanupCancel
  if (!cleanup) return
  state.cleanupCancel = null
  cleanup()
}

function safeAbort(request: UpdaterRequest, log: Logger): void {
  try {
    request.abort()
  } catch (error) {
    log.debug(`Ignoring updater request abort failure: ${errorMessage(error)}`)
  }
}

/**
 * Wraps an AppUpdater's httpExecutor and downloadUpdate so every Electron net.request
 * (ClientRequest) and its IncomingMessage always carry an 'error' listener, late errors after
 * redirects or cancellations are absorbed, and active CancellationTokens abort in-flight requests
 * (including differential blockmap downloads).
 */
export function guardUpdaterHttpExecutor(
  updater: AppUpdater | GuardableUpdater,
  log: Logger,
): void {
  const target = updater as GuardableUpdater
  const executor = target.httpExecutor
  if (!executor || guardedExecutors.has(executor)) return
  guardedExecutors.add(executor)

  const states = new WeakMap<UpdaterRequest, RequestState>()

  const deliverError = (state: RequestState, error: Error): void => {
    if (state.superseded || state.settled || state.closed) {
      log.debug(`Ignored late updater network error: ${errorMessage(error)}`)
      return
    }
    state.settled = true
    cleanupCancel(state)
    if (state.reject) {
      state.reject(error)
      return
    }
    state.pendingError = error
    log.warn(`Updater network error without an active handler: ${errorMessage(error)}`)
  }

  const origCreateRequest = executor.createRequest
  executor.createRequest = function (options, callback) {
    const state: RequestState = {
      reject: null,
      requestErrorHandlerAttached: false,
      pendingError: null,
      settled: false,
      superseded: false,
      closed: false,
      cleanupCancel: null,
    }

    let createdRequest: UpdaterRequest | null = null

    const wrappedCallback = (response: UpdaterResponse): void => {
      // Attach before calling electron-updater's callback because multipleRangeDownloader omits
      // response.on('error') and doDownload/handleResponse return early on HTTP error statuses.
      const onResponseError = (rawError: unknown): void => {
        const error = toError(rawError)
        if (state.superseded || state.settled || state.closed) {
          log.debug(`Ignored late updater response error: ${errorMessage(error)}`)
          return
        }
        if (response.listenerCount('error') === 1) {
          deliverError(state, error)
          return
        }
        // The caller attached its own response error listener; mark settled so any later error on
        // this request or response is treated as late.
        state.settled = true
        cleanupCancel(state)
      }
      response.on('error', onResponseError)

      try {
        callback(response)
      } catch (error) {
        deliverError(state, toError(error))
        if (createdRequest) safeAbort(createdRequest, log)
      }
    }

    const request = origCreateRequest.call(this, options, wrappedCallback)
    createdRequest = request
    states.set(request, state)

    // Always keep an error listener on ClientRequest so EventEmitter never throws uncaught even
    // before addErrorAndTimeoutHandlers runs or if a caller omits it.
    request.on('error', (rawError: unknown) => {
      const error = toError(rawError)
      if (state.requestErrorHandlerAttached) return
      if (state.superseded || state.settled || state.closed) {
        log.debug(`Ignored late updater request error: ${errorMessage(error)}`)
        return
      }
      deliverError(state, error)
    })

    request.once('close', () => {
      state.closed = true
      cleanupCancel(state)
    })

    const token = activeCancellation.getStore()
    if (token) {
      const cancelRequest = (): void => {
        if (state.closed || state.superseded) return
        state.superseded = true
        cleanupCancel(state)
        if (!state.settled && state.reject) {
          state.settled = true
          state.reject(new Error('Download cancelled'))
        }
        safeAbort(request, log)
      }

      if (token.cancelled) {
        // Defer one microtask so the caller finishes addErrorAndTimeoutHandlers and request.end().
        state.superseded = true
        queueMicrotask(() => {
          if (!state.settled && state.reject) {
            state.settled = true
            state.reject(new Error('Download cancelled'))
          }
          if (!state.closed) safeAbort(request, log)
        })
      } else {
        token.once('cancel', cancelRequest)
        state.cleanupCancel = () => {
          token.removeListener('cancel', cancelRequest)
        }
      }
    }

    return request
  }

  const origAddErrorAndTimeoutHandlers = executor.addErrorAndTimeoutHandlers
  executor.addErrorAndTimeoutHandlers = function (request, reject, timeout) {
    const state = states.get(request)
    if (!state) {
      return origAddErrorAndTimeoutHandlers.call(this, request, reject, timeout)
    }

    state.reject = reject
    state.requestErrorHandlerAttached = true

    const guardedReject = (error: Error): void => {
      if (state.superseded || state.settled || state.closed) {
        log.debug(`Ignored late updater request error: ${errorMessage(error)}`)
        return
      }
      state.settled = true
      cleanupCancel(state)
      reject(error)
    }

    origAddErrorAndTimeoutHandlers.call(this, request, guardedReject, timeout)

    if (state.pendingError) {
      const pending = state.pendingError
      state.pendingError = null
      // Clear settled because deliverError marked it while queueing pendingError before reject existed.
      state.settled = false
      queueMicrotask(() => guardedReject(pending))
    }
  }

  const origAddRedirectHandlers = executor.addRedirectHandlers
  if (typeof origAddRedirectHandlers === 'function') {
    executor.addRedirectHandlers = function (request, options, reject, redirectCount, handler) {
      const state = states.get(request)
      if (state) {
        // ElectronHttpExecutor aborts the pre-redirect request inside its 'redirect' listener;
        // mark it superseded first so any ERR_ABORTED / ERR_CONNECTION_RESET it emits cannot reject
        // the follow-up request sharing `reject`.
        request.on('redirect', () => {
          state.superseded = true
          cleanupCancel(state)
        })
      }
      return origAddRedirectHandlers.call(this, request, options, reject, redirectCount, handler)
    }
  }

  const origDoDownload = executor.doDownload
  if (typeof origDoDownload === 'function') {
    executor.doDownload = function (requestOptions, options, redirectCount) {
      const token = options.options?.cancellationToken
      if (!token) return origDoDownload.call(this, requestOptions, options, redirectCount)
      return activeCancellation.run(token, () =>
        origDoDownload.call(this, requestOptions, options, redirectCount),
      )
    }
  }

  const origDoApiRequest = executor.doApiRequest
  if (typeof origDoApiRequest === 'function') {
    executor.doApiRequest = function (options, cancellationToken, requestProcessor, redirectCount) {
      if (!cancellationToken) {
        return origDoApiRequest.call(
          this,
          options,
          cancellationToken,
          requestProcessor,
          redirectCount,
        )
      }
      return activeCancellation.run(cancellationToken, () =>
        origDoApiRequest.call(this, options, cancellationToken, requestProcessor, redirectCount),
      )
    }
  }

  const origDownloadUpdate = target.downloadUpdate
  if (typeof origDownloadUpdate === 'function') {
    target.downloadUpdate = function (cancellationToken?: CancellationToken) {
      if (!cancellationToken) return origDownloadUpdate.call(this)
      return activeCancellation.run(cancellationToken, () =>
        origDownloadUpdate.call(this, cancellationToken),
      )
    }
  }
}
