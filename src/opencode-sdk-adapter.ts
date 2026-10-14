import { OpenCode, type OpenCodeClient } from '@opencode/client'

export function createOpenCodeClient(baseUrl: string, headers: HeadersInit): OpenCodeClient {
  return OpenCode.make({ baseUrl, headers })
}

/**
 * Wraps a shared SDK client so every async request re-verifies the server identity before it is sent.
 * The recursive proxy preserves SDK `this` binding. Verification closures and the proxy WeakMap are
 * scoped to a single call, so they are never reused across tasks. `event.subscribe` keeps its
 * AsyncIterable signature: the original subscription is deferred and `verify` is awaited before the
 * first iteration, so a failed verification never calls the original method (no reconnect, no replay).
 */
export function guardSdkClient(client: OpenCodeClient, verify: () => Promise<void>): OpenCodeClient {
  const proxies = new WeakMap<object, object>()
  const guard = <T extends object>(target: T, isEventNamespace = false): T => {
    const prior = proxies.get(target)
    if (prior) return prior as T
    const proxy = new Proxy(target, {
      get: (object, key, receiver) => {
        const value = Reflect.get(object, key, receiver) as unknown
        if (typeof value === 'function') {
          if (isEventNamespace && key === 'subscribe') {
            return (...args: unknown[]) => (async function* () {
              const signal = abortSignalFromArgs(args)
              // Fail fast before touching the SDK; re-check after the (possibly late) verify so an
              // aborted caller never opens a subscription or triggers a reconnect/replay.
              signal?.throwIfAborted()
              await verify()
              signal?.throwIfAborted()
              const source = Reflect.apply(value, object, args) as AsyncIterable<unknown>
              yield* source
            })()
          }
          return (...args: unknown[]) => {
            const signal = abortSignalFromArgs(args)
            return Promise.resolve()
              .then(() => { signal?.throwIfAborted(); return verify() })
              .then(() => {
                // `verify` may resolve after the caller aborted; re-check so no remote cleanup or
                // tool request is sent on behalf of a cancelled caller.
                signal?.throwIfAborted()
                return Reflect.apply(value, object, args)
              })
          }
        }
        if (typeof value === 'object' && value !== null) return guard(value, key === 'event')
        return value
      },
    })
    proxies.set(target, proxy)
    return proxy
  }
  return guard(client)
}

/** Extracts the optional `AbortSignal` carried by a call's `options` argument. */
function abortSignalFromArgs(args: unknown[]): AbortSignal | undefined {
  for (const arg of args) {
    if (typeof arg === 'object' && arg !== null) {
      const signal = (arg as { signal?: unknown }).signal
      if (signal instanceof AbortSignal) return signal
    }
  }
  return undefined
}

/** Thin SDK construction/cache adapter. It performs no authorization, fallback, or replay. */
export class OpenCodeSdkAdapter {
  private clientPromise: Promise<OpenCodeClient> | undefined
  private clientInstance: OpenCodeClient | undefined
  private clientBaseUrl: string | undefined
  private readonly proxies = new WeakMap<object, object>()

  constructor(
    private readonly baseUrl: () => string,
    private readonly headers: () => HeadersInit,
    private readonly createClient: (baseUrl: string, headers: HeadersInit) => OpenCodeClient = createOpenCodeClient,
    private readonly onInvalidate: (url: string) => void = () => undefined,
    private readonly clientProvider?: () => Promise<OpenCodeClient>,
  ) {}

  getClient(): Promise<OpenCodeClient> {
    if (this.clientProvider) {
      return Promise.resolve().then(() => this.clientProvider!()).then((client) => this.adapt(client))
    }
    if (!this.clientPromise) {
      const baseUrl = this.baseUrl()
      const promise = Promise.resolve().then(() => this.createClient(baseUrl, this.headers())).then((client) => {
        const adapted = this.adapt(client)
        if (this.clientPromise === promise) { this.clientInstance = adapted; this.clientBaseUrl = baseUrl }
        return adapted
      })
      this.clientPromise = promise
      void promise.catch(() => {
        if (this.clientPromise === promise) { this.clientPromise = undefined; this.clientInstance = undefined; this.clientBaseUrl = undefined }
      })
    }
    return this.clientPromise
  }

  private adapt<T extends object>(target: T): T {
    const prior = this.proxies.get(target)
    if (prior) return prior as T
    const proxy = new Proxy(target, {
      get: (object, key, receiver) => {
        const value = Reflect.get(object, key, receiver) as unknown
        if (typeof value === 'function') return (...args: unknown[]) => Reflect.apply(value, object, args)
        if (typeof value === 'object' && value !== null) return this.adapt(value)
        return value
      },
    })
    this.proxies.set(target, proxy)
    return proxy
  }

  invalidate(api: OpenCodeClient | undefined, baseUrl: string | undefined): void {
    if (this.clientProvider) {
      if (baseUrl) this.onInvalidate(baseUrl)
      return
    }
    if (!api || !baseUrl || this.clientInstance !== api || this.clientBaseUrl !== baseUrl) return
    this.clientPromise = undefined
    this.clientInstance = undefined
    this.clientBaseUrl = undefined
    this.onInvalidate(baseUrl)
  }
}
