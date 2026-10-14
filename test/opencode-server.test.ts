import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenCodeClient } from '@opencode/client'
import { OpenCodeServerManager, OpenCodeServerError } from '../src/opencode-server.js'

const REGISTRY_VERSION = '2.0.20'
const SHARED_URL = 'http://127.0.0.1:4096'

let home: string
const registryFile = () => join(home, 'opencode', 'service.json')

function record(overrides: Record<string, unknown> = {}) {
  return { id: 'shared-instance', pid: process.pid, version: REGISTRY_VERSION, url: SHARED_URL, ...overrides }
}

async function writeRecord(value: unknown = record()): Promise<void> {
  await mkdir(dirname(registryFile()), { recursive: true })
  await writeFile(registryFile(), JSON.stringify(value))
}

/**
 * Builds a manager over the real `SharedConnection`, with only the discovery/client/pid seams
 * faked. The SDK client is the sole type-cast reference; every seam is a plain `vi.fn()` whose
 * resolved values keep the connection in-process. No real `Service` or socket is ever touched.
 */
function harness(deprecated: Record<string, unknown> = {}) {
  const info = vi.fn()
  info.mockResolvedValue({ pid: process.pid, version: REGISTRY_VERSION })
  const client = { server: { info } } as unknown as OpenCodeClient
  const createClient = vi.fn()
  createClient.mockReturnValue(client)
  const discover = vi.fn()
  discover.mockResolvedValue({ url: SHARED_URL })
  const pidState = vi.fn()
  pidState.mockReturnValue('alive')

  const manager = new OpenCodeServerManager({
    registryFile: registryFile(),
    discover,
    createClient,
    pidState,
    ...deprecated,
  })
  return { manager, info, createClient, discover, pidState, client }
}

beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'opencode-server-')) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

describe('OpenCodeServerManager shared-service reuse', () => {
  it('reuses one healthy shared client and re-verifies the registration on every call', async () => {
    await writeRecord()
    const { manager, info, createClient, discover, client } = harness()

    const first = await manager.getClient()
    expect(first).toBe(client)
    expect(await manager.getClient()).toBe(client)
    expect(discover).toHaveBeenCalledTimes(2)
    expect(info).toHaveBeenCalledTimes(2)
    expect(createClient).toHaveBeenCalledOnce()

    const { identity } = await manager.connect()
    expect(identity).toEqual({
      id: 'shared-instance', pid: process.pid, url: SHARED_URL, version: REGISTRY_VERSION, registryPath: registryFile(),
    })
  })

  it('passes service auth only to the internal client factory and never exposes it', async () => {
    await writeRecord()
    const info = vi.fn().mockResolvedValue({ pid: process.pid, version: REGISTRY_VERSION })
    const client = { server: { info } } as unknown as OpenCodeClient
    const createClient = vi.fn().mockReturnValue(client)
    const discover = vi.fn().mockResolvedValue({
      url: SHARED_URL,
      auth: { type: 'basic', username: 'opencode', password: 'super-secret' },
    })
    const manager = new OpenCodeServerManager({
      registryFile: registryFile(), discover, createClient, pidState: vi.fn().mockReturnValue('alive'),
    })

    await manager.getClient()
    expect(createClient).toHaveBeenCalledWith(SHARED_URL, expect.any(Object))
    expect(Object.keys(createClient.mock.calls[0][1] ?? {}).length).toBeGreaterThan(0)
    expect(manager.headers).toEqual({})
    expect(JSON.stringify(manager.diagnosticInfo)).not.toContain('super-secret')
    expect(JSON.stringify((await manager.connect()).identity)).not.toContain('super-secret')
  })

  it('throws on baseUrl while no shared service has been connected', () => {
    const { manager } = harness()
    expect(() => manager.baseUrl).toThrow(OpenCodeServerError)
    expect(() => manager.baseUrl).toThrow('not connected')
  })

  it('fails closed without discovery when the registry file is missing', async () => {
    const { manager, discover } = harness()
    await expect(manager.connect()).rejects.toMatchObject({ errorCode: 'service_unavailable' })
    expect(discover).not.toHaveBeenCalled()
  })

  it.each(['dead', 'unknown'] as const)('fails closed without discovery when the registered PID is %s', async (state) => {
    await writeRecord()
    const { manager, discover, pidState } = harness()
    pidState.mockReturnValue(state)
    await expect(manager.connect()).rejects.toMatchObject({ errorCode: 'service_unavailable' })
    expect(discover).not.toHaveBeenCalled()
  })

  it('rejects a transient health failure, then connects once the service recovers', async () => {
    await writeRecord()
    const { manager, info } = harness()
    info.mockRejectedValueOnce(new Error('boom'))

    await expect(manager.connect()).rejects.toMatchObject({ errorCode: 'service_unavailable' })
    expect(() => manager.baseUrl).toThrow('not connected')

    const { client } = await manager.connect()
    expect(client).toBeDefined()
    expect(manager.baseUrl).toBe(SHARED_URL)
  })

  it('rejects once and invalidates when the shared identity changes between calls', async () => {
    await writeRecord()
    const { manager, info } = harness()
    await manager.connect()

    info.mockResolvedValue({ pid: process.pid + 1, version: REGISTRY_VERSION })
    await expect(manager.connect()).rejects.toMatchObject({ errorCode: 'service_unavailable' })
    expect(() => manager.baseUrl).toThrow('not connected')
  })

  it('rejects a mismatched pinned identity and invalidates the connection', async () => {
    await writeRecord()
    const { manager } = harness()
    const { identity } = await manager.connect()

    await expect(manager.assertIdentity({ ...identity, pid: process.pid + 1 }))
      .rejects.toMatchObject({ errorCode: 'service_unavailable' })
    expect(() => manager.baseUrl).toThrow('not connected')

    await manager.connect()
    await expect(manager.assertIdentity(identity)).resolves.toBeUndefined()
  })

  it('never calls the deprecated lifecycle options, for either reuseOnly value', async () => {
    await writeRecord()
    const deprecatedFns = {
      ensureService: vi.fn(), discoverService: vi.fn(), stopService: vi.fn(), registryExists: vi.fn(),
      isProcessDead: vi.fn(), readServiceIdentity: vi.fn(), removePrivateState: vi.fn(), ownsEndpoint: vi.fn(),
    }
    const deprecatedScalars = {
      command: 'opencode', host: '0.0.0.0', port: 9_999, username: 'codex', password: 'secret',
      privateStateHome: 'C:\\private', stopTimeoutMs: 1,
    }

    for (const reuseOnly of [true, false]) {
      const { manager, client } = harness({ ...deprecatedFns, ...deprecatedScalars, reuseOnly })
      expect(await manager.getClient()).toBe(client)
      expect(manager).not.toHaveProperty('privateStateHomePath')
    }

    for (const fn of Object.values(deprecatedFns)) expect(fn).not.toHaveBeenCalled()
  })

  it('close never stops the service and rejects further connects', async () => {
    await writeRecord()
    const stopService = vi.fn()
    const { manager, client } = harness({ stopService })

    expect(await manager.getClient()).toBe(client)
    await manager.close()
    expect(stopService).not.toHaveBeenCalled()

    await expect(manager.connect()).rejects.toMatchObject({
      errorCode: 'service_unavailable', message: 'OpenCode service manager is closed.',
    })
    expect(() => manager.baseUrl).toThrow('not connected')
  })
})
