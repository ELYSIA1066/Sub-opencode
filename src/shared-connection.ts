import { readFile } from 'node:fs/promises'
import type { OpenCodeClient } from '@opencode/client'
import { Service } from '@opencode/client/service'
import { isCompatibleServiceVersion } from './service-registry.js'
import { createSdkClient, disposeSdkClient } from './sdk-transport.js'

/**
 * The one module responsible for reusing a healthy, already-registered OpenCode background
 * service. It only discovers and verifies a shared registration; it never starts, stops, moves,
 * or rewrites a service registration.
 *
 * The full registration record (which may contain authentication material) is read into memory
 * only to derive a redacted identity and to detect changes between read-only SDK calls. Neither
 * the record nor the auth headers are ever returned, logged, or attached to an error message.
 */
export type SharedConnectionIdentity = {
  readonly id: string
  readonly pid: number
  readonly url: string
  readonly version: string
  readonly registryPath: string
}

export type SharedConnectionOptions = {
  /** Absolute path of the shared OpenCode service registration file. */
  registryFile: string
  /** Read-only discovery. Defaults to `Service.discover`. */
  discover?: typeof Service.discover
  /** SDK client factory. Defaults to `OpenCode.make`. Receives only the base URL and auth headers. */
  createClient?: (baseUrl: string, headers: HeadersInit) => OpenCodeClient
  /** Process liveness probe. Defaults to `process.kill(pid, 0)` where only `ESRCH` is `dead`. */
  pidState?: (pid: number) => 'alive' | 'dead' | 'unknown'
}

/** Fail-closed connection error. Every message is fixed and safe; the cause carries the detail. */
export class SharedConnectionError extends Error {
  readonly errorCode = 'service_unavailable'
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SharedConnectionError'
  }
}

export class SharedConnection {
  private readonly registryFile: string
  private readonly discover: typeof Service.discover
  private readonly createClient: (baseUrl: string, headers: HeadersInit) => OpenCodeClient
  private readonly pidState: (pid: number) => 'alive' | 'dead' | 'unknown'
  private snapshot: SharedConnectionIdentity | undefined
  private client: OpenCodeClient | undefined
  private closed = false
  /**
   * Monotonic cache generation. Any invalidation, close, or failure based cache clear bumps it so
   * an in-flight `connect` cannot re-cache or return a result produced under an older generation.
   */
  private generation = 0

  constructor(options: SharedConnectionOptions) {
    this.registryFile = options.registryFile
    this.discover = options.discover ?? Service.discover
    this.createClient = options.createClient ?? createSdkClient
    this.pidState = options.pidState ?? defaultPidState
  }

  /**
   * Read the shared registration, confirm it is a live SDK-compatible loopback service of the registered
   * identity, and return a verified SDK client. Every call re-reads the registration and re-runs
   * the read-only discover and `server.info` health checks, even when a cached client is reused.
   * Any change, mismatch, or probe failure clears the cache and fails closed. A later explicit
   * `connect` may retry from scratch; nothing is replayed automatically.
   */
  async connect(): Promise<{ client: OpenCodeClient; identity: SharedConnectionIdentity }> {
    if (this.closed) throw this.failure('The shared OpenCode connection is closed.')
    const generation = this.generation

    let raw: string
    let identity: SharedConnectionIdentity
    try {
      ({ raw, identity } = await this.readIdentity())
    } catch (error) {
      this.clear()
      throw error
    }

    if (this.snapshot && !sameIdentity(this.snapshot, identity)) {
      this.clear()
      throw this.failure('The registered OpenCode service identity changed; refusing to adopt it automatically.')
    }

    let endpoint: Awaited<ReturnType<typeof Service.discover>>
    try {
      endpoint = await this.discover({ file: this.registryFile, version: identity.version })
    } catch (cause) {
      this.clear()
      throw this.failure('Unable to discover the registered OpenCode service.', cause)
    }
    if (!endpoint) {
      this.clear()
      throw this.failure('The registered OpenCode service is not healthy or compatible.')
    }
    if (endpoint.url !== identity.url) {
      this.clear()
      throw this.failure('The discovered OpenCode service does not match the registered identity.')
    }
    await this.assertUnchanged(raw)

    let client: OpenCodeClient
    if (this.client && this.snapshot && sameIdentity(this.snapshot, identity)) {
      client = this.client
    } else {
      try {
        client = this.createClient(endpoint.url, Service.headers(endpoint) ?? {})
      } catch (cause) {
        this.clear()
        throw this.failure('Unable to construct an OpenCode SDK client.', cause)
      }
    }

    let info: Awaited<ReturnType<OpenCodeClient['server']['info']>>
    try {
      info = await client.server.info()
    } catch (cause) {
      this.clear()
      throw this.failure('The registered OpenCode service did not answer a health check.', cause)
    }
    if (info.pid !== identity.pid || info.version !== identity.version) {
      this.clear()
      throw this.failure('The OpenCode service identity did not match the registration.')
    }
    await this.assertUnchanged(raw)

    // Re-confirm the process is still alive immediately before committing the cache.
    let finalState: 'alive' | 'dead' | 'unknown'
    try {
      finalState = this.pidStateSafely(identity.pid)
    } catch (error) {
      this.clear()
      throw error
    }
    if (finalState !== 'alive') {
      this.clear()
      throw this.failure('The registered OpenCode service process is no longer confirmed alive.')
    }

    // An invalidation or close that raced any await above must win over this completion.
    if (this.closed || this.generation !== generation) {
      this.clear()
      throw this.failure('The shared OpenCode connection was invalidated during verification.')
    }

    this.snapshot = { ...identity }
    this.client = client
    return { client, identity: { ...identity } }
  }

  /** Drop the cached identity and client. Does not touch the service or its registration. */
  invalidate(): void {
    this.clear()
  }

  /** Release only this module's own cache. Never stops a service and never writes a file. */
  close(): void {
    this.closed = true
    this.clear()
  }

  private async readIdentity(): Promise<{ raw: string; identity: SharedConnectionIdentity }> {
    let raw: string
    try {
      raw = await readFile(this.registryFile, 'utf8')
    } catch (cause) {
      throw this.failure('No readable shared OpenCode service registration was found.', cause)
    }
    let record: unknown
    try {
      record = JSON.parse(raw)
    } catch (cause) {
      throw this.failure('The shared OpenCode service registration is not valid JSON.', cause)
    }
    const identity = parseIdentity(record, this.registryFile)
    if (!identity) throw this.failure('The shared OpenCode service registration is missing required identity fields.')
    if (!isLoopbackOrigin(identity.url)) throw this.failure('The shared OpenCode service URL must be a credential-free HTTP(S) loopback origin.')
    if (!isCompatibleServiceVersion(identity.version)) throw this.failure('The shared OpenCode service version is not compatible with the installed SDK.')
    if (this.pidStateSafely(identity.pid) !== 'alive') {
      throw this.failure('The registered OpenCode service process is not confirmed alive.')
    }
    return { raw, identity }
  }

  private async assertUnchanged(expected: string): Promise<void> {
    let current: string
    try {
      current = await readFile(this.registryFile, 'utf8')
    } catch (cause) {
      this.clear()
      throw this.failure('The shared OpenCode service registration disappeared during verification.', cause)
    }
    if (current !== expected) {
      this.clear()
      throw this.failure('The shared OpenCode service registration changed during verification.')
    }
  }

  /** A throwing probe is wrapped in a fixed error; its original message is never surfaced. */
  private pidStateSafely(pid: number): 'alive' | 'dead' | 'unknown' {
    try {
      return this.pidState(pid)
    } catch (cause) {
      throw this.failure('Unable to determine the registered OpenCode service process state.', cause)
    }
  }

  private clear(): void {
    if (this.client) disposeSdkClient(this.client)
    this.generation += 1
    this.snapshot = undefined
    this.client = undefined
  }

  private failure(message: string, cause?: unknown): SharedConnectionError {
    return cause === undefined ? new SharedConnectionError(message) : new SharedConnectionError(message, { cause })
  }
}

function parseIdentity(record: unknown, registryPath: string): SharedConnectionIdentity | undefined {
  if (typeof record !== 'object' || record === null) return undefined
  const value = record as Record<string, unknown>
  if (typeof value.id !== 'string' || value.id.length === 0) return undefined
  if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0) return undefined
  if (typeof value.version !== 'string' || value.version.length === 0) return undefined
  if (typeof value.url !== 'string' || value.url.length === 0) return undefined
  return { id: value.id, pid: value.pid, url: value.url, version: value.version, registryPath }
}

function sameIdentity(left: SharedConnectionIdentity, right: SharedConnectionIdentity): boolean {
  return left.id === right.id
    && left.pid === right.pid
    && left.url === right.url
    && left.version === right.version
    && left.registryPath === right.registryPath
}

/**
 * Only a bare HTTP(S) loopback origin is accepted: no userinfo, no query, no fragment, and a
 * root path. Anything else could smuggle a credential or redirect target into the identity.
 */
function isLoopbackOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (url.username !== '' || url.password !== '') return false
    if (url.search !== '' || url.hash !== '') return false
    if (url.pathname !== '/') return false
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
  } catch {
    return false
  }
}

/** Only a demonstrably absent PID is `dead`; permission and other errors stay `unknown`. */
function defaultPidState(pid: number): 'alive' | 'dead' | 'unknown' {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'
  }
}
