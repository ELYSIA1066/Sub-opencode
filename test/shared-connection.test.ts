import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenCodeClient } from '@opencode/client'
import { SharedConnection, SharedConnectionError, type SharedConnectionOptions } from '../src/shared-connection.js'

const SHARED_URL = 'http://127.0.0.1:49374'
const REGISTRY_VERSION = '2.0.20'

let home: string
const registryFile = () => join(home, 'opencode', 'service.json')

function record(overrides: Record<string, unknown> = {}) {
  return { id: 'shared-instance', pid: process.pid, version: REGISTRY_VERSION, url: SHARED_URL, ...overrides }
}

async function writeRecord(value: unknown = record()): Promise<void> {
  await mkdir(dirname(registryFile()), { recursive: true })
  await writeFile(registryFile(), JSON.stringify(value))
}

type ClientInfo = { pid: number; version: string }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Minimal SDK-shaped stub; only the surface the connection actually calls is provided. */
function harness(overrides: {
  discover?: (options?: unknown) => Promise<unknown>
  createClient?: (baseUrl: string, headers: HeadersInit) => OpenCodeClient
  pidState?: (pid: number) => 'alive' | 'dead' | 'unknown'
  info?: () => Promise<ClientInfo>
} = {}) {
  const serverInfo = vi.fn(overrides.info ?? (async () => ({ pid: process.pid, version: REGISTRY_VERSION })))
  const client = { server: { info: serverInfo } } as unknown as OpenCodeClient
  const discover = vi.fn(overrides.discover ?? (async () => ({ url: SHARED_URL, auth: undefined })))
  const createClient = vi.fn(overrides.createClient ?? (() => client))
  const pidState = vi.fn(overrides.pidState ?? (() => 'alive' as const))
  const connection = new SharedConnection({
    registryFile: registryFile(),
    discover: discover as unknown as SharedConnectionOptions['discover'],
    createClient: createClient as unknown as SharedConnectionOptions['createClient'],
    pidState: pidState as unknown as SharedConnectionOptions['pidState'],
  })
  return { connection, discover, createClient, pidState, serverInfo, client }
}

beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'shared-connection-')) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

describe('SharedConnection shared-service reuse', () => {
  it('reuses a healthy cached client while re-checking the registration and server.info on every call', async () => {
    await writeRecord()
    const { connection, discover, createClient, serverInfo, client } = harness()

    const first = await connection.connect()
    expect(first.identity).toEqual({
      id: 'shared-instance', pid: process.pid, url: SHARED_URL, version: REGISTRY_VERSION, registryPath: registryFile(),
    })
    expect(discover).toHaveBeenCalledOnce()
    expect(serverInfo).toHaveBeenCalledOnce()
    expect(createClient).toHaveBeenCalledOnce()

    const second = await connection.connect()
    expect(second.client).toBe(client)
    expect(discover).toHaveBeenCalledTimes(2)
    expect(serverInfo).toHaveBeenCalledTimes(2)
    expect(createClient).toHaveBeenCalledOnce()
  })

  it('never exposes service authentication in the returned identity', async () => {
    await writeRecord()
    const { connection } = harness({
      discover: async () => ({ url: SHARED_URL, auth: { type: 'basic', username: 'opencode', password: 'super-secret' } }),
    })
    const result = await connection.connect()
    expect(JSON.stringify(result.identity)).not.toContain('super-secret')
    expect(Object.keys(result.identity).sort()).toEqual(['id', 'pid', 'registryPath', 'url', 'version'])
  })

  it('fails closed when the registration is missing', async () => {
    const { connection, discover } = harness()
    await expect(connection.connect()).rejects.toMatchObject({ errorCode: 'service_unavailable' })
    expect(discover).not.toHaveBeenCalled()
  })

  it.each(['dead', 'unknown'] as const)('fails closed when the registered PID is %s', async (state) => {
    await writeRecord()
    const { connection, discover } = harness({ pidState: () => state })
    await expect(connection.connect()).rejects.toMatchObject({ errorCode: 'service_unavailable' })
    expect(discover).not.toHaveBeenCalled()
  })

  it('wraps a throwing PID probe without leaking its message', async () => {
    await writeRecord()
    const { connection } = harness({ pidState: () => { throw new Error('secret-pid-failure') } })
    const error = await connection.connect().then(() => undefined, (value: unknown) => value)
    expect(error).toBeInstanceOf(SharedConnectionError)
    expect(error).toMatchObject({ errorCode: 'service_unavailable' })
    expect((error as Error).message).not.toContain('secret-pid-failure')
  })

  it.each([
    ['non-loopback host', 'http://192.168.1.10:49374'],
    ['credentials', 'http://user:pass@127.0.0.1:49374'],
    ['query', 'http://127.0.0.1:49374/?token=secret'],
    ['fragment', 'http://127.0.0.1:49374/#secret'],
    ['non-root path', 'http://127.0.0.1:49374/api'],
  ])('fails closed for a %s registration URL without exposing it', async (_label, url) => {
    await writeRecord(record({ url }))
    const { connection, discover } = harness({ discover: async () => ({ url, auth: undefined }) })
    const error = await connection.connect().then(() => undefined, (value: unknown) => value)
    expect(error).toMatchObject({ errorCode: 'service_unavailable' })
    expect((error as Error).message).not.toContain('secret')
    expect((error as Error).message).not.toContain('pass')
    expect(discover).not.toHaveBeenCalled()
  })

  it('fails closed for a non-v2 registration version', async () => {
    await writeRecord(record({ version: '1.9.0' }))
    const { connection, discover } = harness({ discover: async () => ({ url: SHARED_URL, auth: undefined }) })
    await expect(connection.connect()).rejects.toMatchObject({ errorCode: 'service_unavailable' })
    expect(discover).not.toHaveBeenCalled()
  })

  it('fails closed when the registration changes during discovery', async () => {
    await writeRecord()
    const { connection, createClient } = harness({
      discover: async () => {
        await writeRecord(record({ id: 'replaced' }))
        return { url: SHARED_URL, auth: undefined }
      },
    })
    await expect(connection.connect()).rejects.toMatchObject({ errorCode: 'service_unavailable' })
    expect(createClient).not.toHaveBeenCalled()
  })

  it('fails closed when the registration changes during the health check', async () => {
    await writeRecord()
    const { connection, serverInfo } = harness({
      info: async () => {
        await writeRecord(record({ id: 'replaced' }))
        return { pid: process.pid, version: REGISTRY_VERSION }
      },
    })
    await expect(connection.connect()).rejects.toMatchObject({ errorCode: 'service_unavailable' })
    expect(serverInfo).toHaveBeenCalledOnce()
  })

  it('re-checks the PID immediately before caching and fails closed if it is gone', async () => {
    await writeRecord()
    const states: Array<'alive' | 'dead'> = ['alive', 'dead']
    const { connection } = harness({ pidState: () => states.shift() ?? 'dead' })
    await expect(connection.connect()).rejects.toMatchObject({ errorCode: 'service_unavailable' })
  })

  it('clears the cache after a health failure and reconnects on the next explicit connect', async () => {
    await writeRecord()
    let healthy = false
    const { connection, createClient } = harness({
      info: async () => {
        if (!healthy) throw new Error('unreachable')
        return { pid: process.pid, version: REGISTRY_VERSION }
      },
    })
    await expect(connection.connect()).rejects.toMatchObject({ errorCode: 'service_unavailable' })
    healthy = true
    await expect(connection.connect()).resolves.toMatchObject({ identity: { id: 'shared-instance' } })
    expect(createClient).toHaveBeenCalledTimes(2)
  })

  it('does not cache a health result that resolves after invalidate', async () => {
    await writeRecord()
    const gate = deferred<ClientInfo>()
    const { connection, serverInfo, createClient } = harness({ info: () => gate.promise })
    const pending = connection.connect()
    await vi.waitFor(() => expect(serverInfo).toHaveBeenCalledOnce())

    connection.invalidate()
    gate.resolve({ pid: process.pid, version: REGISTRY_VERSION })

    await expect(pending).rejects.toMatchObject({ errorCode: 'service_unavailable' })
    // The late completion was not cached: the next explicit connect builds a fresh client.
    await expect(connection.connect()).resolves.toMatchObject({ identity: { id: 'shared-instance' } })
    expect(createClient).toHaveBeenCalledTimes(2)
  })

  it('does not return a health result that resolves after close', async () => {
    await writeRecord()
    const gate = deferred<ClientInfo>()
    const { connection, serverInfo } = harness({ info: () => gate.promise })
    const pending = connection.connect()
    await vi.waitFor(() => expect(serverInfo).toHaveBeenCalledOnce())

    connection.close()
    gate.resolve({ pid: process.pid, version: REGISTRY_VERSION })

    await expect(pending).rejects.toMatchObject({ errorCode: 'service_unavailable' })
    await expect(connection.connect()).rejects.toMatchObject({ errorCode: 'service_unavailable' })
  })

  it('rejects an identity change after caching, then adopts it on the next explicit connect', async () => {
    await writeRecord()
    const { connection, createClient } = harness()
    const first = await connection.connect()
    expect(first.identity.id).toBe('shared-instance')

    await writeRecord(record({ id: 'new-instance' }))
    await expect(connection.connect()).rejects.toMatchObject({ errorCode: 'service_unavailable' })

    const second = await connection.connect()
    expect(second.identity.id).toBe('new-instance')
    expect(createClient).toHaveBeenCalledTimes(2)
  })

  it('can reconnect after an initial discovery failure', async () => {
    await writeRecord()
    let attempt = 0
    const { connection } = harness({
      discover: async () => {
        attempt += 1
        if (attempt === 1) throw new Error('temporary discovery failure')
        return { url: SHARED_URL, auth: undefined }
      },
    })
    await expect(connection.connect()).rejects.toMatchObject({ errorCode: 'service_unavailable' })
    await expect(connection.connect()).resolves.toMatchObject({ identity: { id: 'shared-instance' } })
  })
})
