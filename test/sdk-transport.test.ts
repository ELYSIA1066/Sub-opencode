import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { afterEach, describe, expect, it } from 'vitest'
import { OpenCode } from '@opencode/client'
import { createSdkClient, disposeSdkClient } from '../src/sdk-transport.js'
import { createOpenCodeClient } from '../src/opencode-sdk-adapter.js'
import { SharedConnection } from '../src/shared-connection.js'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installedClientVersion } from '../src/service-registry.js'

const originalDispatcher = getGlobalDispatcher()
const servers: Server[] = []
const clients: ReturnType<typeof createSdkClient>[] = []
const agents: Agent[] = []
const timers = new Set<NodeJS.Timeout>()
function later(action: () => void, delay = 1_100) {
  const timer = setTimeout(() => { timers.delete(timer); action() }, delay)
  timers.add(timer)
}
async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test address')
  return `http://127.0.0.1:${address.port}`
}
function shortHttpTimeouts() {
  const agent = new Agent({ headersTimeout: 50, bodyTimeout: 50 })
  agents.push(agent)
  setGlobalDispatcher(agent)
}
function client(url: string) {
  const api = createOpenCodeClient(url, { 'x-test-transport': 'preserved' })
  clients.push(api)
  return api
}

afterEach(async () => {
  setGlobalDispatcher(originalDispatcher)
  for (const api of clients.splice(0)) disposeSdkClient(api)
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  await Promise.all(agents.splice(0).map((agent) => agent.destroy()))
})

describe('signal-bound SDK HTTP deadlines', () => {
  it('uses the deadline-aware transport through the production shared connection factory', async () => {
    shortHttpTimeouts()
    const version = installedClientVersion()
    const url = await listen((req, res) => {
      if (req.url === '/api/info') res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ pid: process.pid, version }))
      else later(() => res.writeHead(204).end())
    })
    const root = await mkdtemp(join(tmpdir(), 'sdk-transport-'))
    const registryFile = join(root, 'service.json')
    await writeFile(registryFile, JSON.stringify({ id: 'transport-test', pid: process.pid, version, url }))
    const connection = new SharedConnection({ registryFile, discover: async () => ({ url, auth: undefined }) })
    try {
      const { client: api } = await connection.connect()
      await expect(api.session.wait({ sessionID: 'shared' }, { signal: AbortSignal.timeout(4_000) })).resolves.toBeUndefined()
    } finally { connection.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('survives a delayed wait response while the unmodified SDK hits its HTTP header timeout', async () => {
    shortHttpTimeouts()
    let requests = 0
    const url = await listen((req, res) => {
      requests++
      expect(req.method).toBe('POST')
      later(() => res.writeHead(204).end())
    })
    const old = OpenCode.make({ baseUrl: url })
    const control = old.session.wait({ sessionID: 'baseline' }, { signal: AbortSignal.timeout(4_000) }).catch((error: unknown) => error)
    await expect(client(url).session.wait({ sessionID: 'fixed' }, { signal: AbortSignal.timeout(4_000) })).resolves.toBeUndefined()
    expect(await control).toMatchObject({ reason: 'Transport', cause: { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } } })
    expect(requests).toBe(2)
    expect(getGlobalDispatcher()).toBe(agents[0])
  })

  it('keeps a silent event stream open until the caller deadline, preserving auth headers', async () => {
    shortHttpTimeouts()
    const url = await listen((req, res) => {
      expect(req.headers['x-test-transport']).toBe('preserved')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"type":"server.connected","data":{}}\n\n')
      later(() => res.write('data: {"type":"server.connected","data":{}}\n\n'))
    })
    const controller = new AbortController()
    const iterator = client(url).event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]()
    try {
      expect((await iterator.next()).value?.type).toBe('server.connected')
      expect((await iterator.next()).value?.type).toBe('server.connected')
    } finally { controller.abort(); await iterator.return?.() }
  })

  it('still honors cancellation without replaying the request', async () => {
    let requests = 0
    const url = await listen(() => { requests++ })
    const started = Date.now()
    await expect(client(url).session.wait({ sessionID: 'abort' }, { signal: AbortSignal.timeout(100) })).rejects.toMatchObject({ reason: 'Transport' })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(requests).toBe(1)
  })

  it('preserves genuine connection failures rather than retrying them', async () => {
    let requests = 0
    const url = await listen((_req, res) => { requests++; res.destroy() })
    await expect(client(url).session.wait({ sessionID: 'disconnect' }, { signal: AbortSignal.timeout(2_000) })).rejects.toMatchObject({ reason: 'Transport' })
    expect(requests).toBe(1)
  })

  it('does not remove HTTP timeouts for requests lacking a caller signal', async () => {
    shortHttpTimeouts()
    const url = await listen((_req, res) => later(() => res.writeHead(204).end()))
    await expect(client(url).session.wait({ sessionID: 'no-deadline' })).rejects.toMatchObject({ reason: 'Transport', cause: { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } } })
  })

  it('destroys its own in-flight transport on invalidation without closing the global dispatcher', async () => {
    let received!: () => void
    const ready = new Promise<void>((resolve) => { received = resolve })
    const url = await listen(() => received())
    const api = client(url)
    const pending = api.session.wait({ sessionID: 'dispose' }, { signal: AbortSignal.timeout(2_000) }).catch((error: unknown) => error)
    await ready
    disposeSdkClient(api)
    expect(await pending).toMatchObject({ reason: 'Transport' })
    expect(getGlobalDispatcher()).toBe(originalDispatcher)
  })
})
