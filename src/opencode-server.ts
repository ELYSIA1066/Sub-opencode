import type { OpenCodeClient } from '@opencode/client'
import {
  SharedConnection,
  SharedConnectionError,
  type SharedConnectionIdentity,
  type SharedConnectionOptions,
} from './shared-connection.js'
import { resolveRegistryPath } from './service-registry.js'

export type { SharedConnectionIdentity } from './shared-connection.js'

type SharedDiscover = NonNullable<SharedConnectionOptions['discover']>
type SharedCreateClient = NonNullable<SharedConnectionOptions['createClient']>
type SharedPidState = NonNullable<SharedConnectionOptions['pidState']>

export type OpenCodeServerOptions = {
  /** Absolute path of the shared OpenCode service registration to reuse. Defaults to the XDG state directory. */
  registryFile?: string

  // --- Test seams, passed straight through to SharedConnection. ---
  /** Read-only registration discovery. Defaults to `Service.discover` inside SharedConnection. */
  discover?: SharedDiscover
  /** SDK client factory. Receives only the base URL and auth headers. */
  createClient?: SharedCreateClient
  /** Process liveness probe. Defaults to `process.kill(pid, 0)`. */
  pidState?: SharedPidState
  /** Inject a constructed SharedConnection. Takes precedence over the seams above. */
  connection?: SharedConnection

}

type Health = { healthy: true; version: string }

/** Fail-closed connection error. Every message is fixed and safe; the cause carries any detail. */
export class OpenCodeServerError extends Error {
  readonly errorCode = 'service_unavailable'
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OpenCodeServerError'
  }
}

/**
 * Compatibility facade over `SharedConnection`. It only discovers and reuses a healthy,
 * already-registered OpenCode service through the shared connection. It owns no service lifecycle:
 * no start, recovery, registration move, private state, authentication fallback, or second client
 * cache. All connection failures surface as `OpenCodeServerError` with `service_unavailable`.
 */
export class OpenCodeServerManager {
  private readonly connection: SharedConnection
  /** Last verified shared identity, used only to answer read-only compatibility getters. */
  private identity: SharedConnectionIdentity | undefined
  private closed = false

  constructor(options: OpenCodeServerOptions) {
    this.connection = options.connection ?? new SharedConnection({
      registryFile: resolveRegistryPath({ explicit: options.registryFile }),
      ...(options.discover ? { discover: options.discover } : {}),
      ...(options.createClient ? { createClient: options.createClient } : {}),
      ...(options.pidState ? { pidState: options.pidState } : {}),
    })
  }

  /**
   * Reuse the shared, already-registered client. Each call lets `SharedConnection` re-read and
   * re-verify the registration; nothing here caches a health promise or a second client.
   */
  async connect(): Promise<{ client: OpenCodeClient; identity: SharedConnectionIdentity }> {
    if (this.closed) throw new OpenCodeServerError('OpenCode service manager is closed.')
    try {
      const result = await this.connection.connect()
      this.identity = result.identity
      return result
    } catch (cause) {
      this.identity = undefined
      throw toServerError(cause)
    }
  }

  /** The shared SDK client for the next slice. Delegates entirely to `SharedConnection`. */
  async getClient(): Promise<OpenCodeClient> {
    return (await this.connect()).client
  }

  /**
   * Compatibility health check. Re-reads and re-verifies the shared registration on every call and
   * caches no health promise.
   */
  async ensureReady(): Promise<Health> {
    const { identity } = await this.connect()
    return { healthy: true, version: identity.version }
  }

  /**
   * The verified URL of the connected shared service. Throws while not connected; it never falls
   * back to the configured (and ignored) host/port.
   */
  get baseUrl(): string {
    if (!this.identity) throw new OpenCodeServerError('The shared OpenCode service is not connected.')
    return this.identity.url
  }

  /**
   * Compatibility no-op. Authentication is owned by `SharedConnection` and its client; this facade
   * never derives, caches, or logs header or auth material.
   */
  get headers(): HeadersInit {
    return {}
  }

  /** Redacted diagnostic view derived from the shared identity. Never contains headers or auth. */
  get diagnosticInfo(): { source: string; identity?: { id: string; pid: number; url: string }; version: string } {
    const identity = this.identity
    if (!identity) return { source: 'shared', version: 'unknown' }
    return {
      source: 'shared',
      identity: { id: identity.id, pid: identity.pid, url: identity.url },
      version: identity.version,
    }
  }

  /**
   * Drop only the shared connection's own cached identity/client. When `expectedBaseUrl` is given,
   * it acts only if the connected identity still matches. Never touches a service or registration.
   */
  invalidate(expectedBaseUrl?: string): boolean {
    if (this.closed || !this.identity) return false
    if (expectedBaseUrl !== undefined && this.identity.url !== expectedBaseUrl) return false
    this.connection.invalidate()
    this.identity = undefined
    return true
  }

  /**
   * Fail-closed pin. Verifies the currently registered shared service matches the pinned
   * `expected` identity. On any mismatch it invalidates the connection so a different service is
   * never adopted to complete an older task.
   */
  async assertIdentity(expected: SharedConnectionIdentity): Promise<void> {
    if (this.closed) throw new OpenCodeServerError('OpenCode service manager is closed.')
    let actual: SharedConnectionIdentity
    try {
      ({ identity: actual } = await this.connection.connect())
    } catch (cause) {
      this.identity = undefined
      throw toServerError(cause)
    }
    if (!sameSharedIdentity(expected, actual)) {
      this.connection.invalidate()
      this.identity = undefined
      throw new OpenCodeServerError('The shared OpenCode service identity did not match the pinned identity.')
    }
    this.identity = actual
  }

  /**
   * Release only this facade's and `SharedConnection`'s own cached state. Bounded and synchronous:
   * it never waits on, stops, registers, or moves a service. The deadline argument is accepted for
   * source compatibility and ignored.
   */
  async close(_deadline = Date.now() + 10_000): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.identity = undefined
    this.connection.close()
  }
}

function sameSharedIdentity(left: SharedConnectionIdentity, right: SharedConnectionIdentity): boolean {
  return left.id === right.id
    && left.pid === right.pid
    && left.url === right.url
    && left.version === right.version
    && left.registryPath === right.registryPath
}

function toServerError(cause: unknown): OpenCodeServerError {
  if (cause instanceof OpenCodeServerError) return cause
  if (cause instanceof SharedConnectionError) return new OpenCodeServerError(cause.message, { cause })
  return new OpenCodeServerError('The shared OpenCode service is unavailable.', { cause })
}
