import { describe, expect, it, vi } from 'vitest'
import type { OpenCodeClient } from '@opencode/client'
import { probePermissions } from '../tools/acceptance/permission-probe.js'

function fixture(options: { cascade?: boolean; stale500?: boolean; hangCleanup?: boolean; eof?: boolean } = {}) {
  const pending = new Map<string, { request: any; finish: (value: any) => void }>()
  const events: any[] = []
  let wake: (() => void) | undefined
  let permissions: any[] = []
  let removed = false
  let rejected = false
  const push = (event: any) => { events.push(event); wake?.() }
  const api = {
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      yield { type: 'server.connected' }
      while (!signal.aborted) {
        if (events.length) { yield events.shift(); continue }
        if (options.eof) return
        await new Promise<void>((done) => {
          const finish = () => { signal.removeEventListener('abort', finish); wake = undefined; done() }
          wake = finish; signal.addEventListener('abort', finish, { once: true }); if (signal.aborted) finish()
        })
      }
    } },
    session: {
      create: vi.fn(async (input: any) => { permissions = input.permissions; return { id: 'probe', permissions } }),
      get: vi.fn(async () => { if (removed) throw { _tag: 'SessionNotFoundError' }; return { permissions } }),
      update: vi.fn(async (input: any) => { permissions = input.permissions }),
      wait: vi.fn(() => options.hangCleanup ? new Promise(() => {}) : Promise.resolve()),
      remove: vi.fn(async () => { removed = true }),
    },
    message: { list: vi.fn(async () => ({ data: [], cursor: {} })) },
    permission: {
      create: vi.fn((request: any, { signal }: { signal: AbortSignal }) => new Promise((finish, reject) => {
        const abort = () => reject(new Error('aborted'))
        signal.addEventListener('abort', abort, { once: true })
        pending.set(request.id, { request, finish: (value) => { signal.removeEventListener('abort', abort); finish(value) } })
        push({ type: 'permission.asked', data: request })
      })),
      list: vi.fn(async () => [...pending.values()].map((entry) => entry.request)),
      reply: vi.fn(async ({ requestID, decision }: any) => {
        if (!pending.has(requestID)) {
          if (options.stale500) throw { name: 'ClientError', cause: { status: 500 } }
          throw { _tag: 'PermissionNotFoundError', requestID }
        }
        rejected = true
        for (const [id, entry] of [...pending]) {
          if (options.cascade === false && id !== requestID) continue
          pending.delete(id); entry.finish({ id, effect: 'deny' })
          push({ type: 'permission.replied', data: { sessionID: 'probe', requestID: id, reply: decision } })
        }
      }),
    },
  }
  return { api: api as unknown as OpenCodeClient, raw: api, pending, rejected: () => rejected }
}

describe('zero-model permission probe', () => {
  it('uses real-shaped requests, verifies cascade/stale404 and removes only its session', async () => {
    const f = fixture()
    const result = await probePermissions(f.api, process.cwd(), { timeoutMs: 200, cleanupMs: 100 })
    expect(result).toMatchObject({ passed: true, promptSubmissions: 0, cascadeVerified: true, threePending: true, staleReply: { status: 404 }, cleanup: { deleted: true, denyAll: true } })
    expect(f.raw.permission.create).toHaveBeenCalledTimes(3)
    for (const [input] of f.raw.permission.create.mock.calls) expect(input).not.toHaveProperty('source')
    expect(f.raw.permission.reply).toHaveBeenCalledTimes(2)
  })
  it('stops the gate when the server does not cascade, while cleaning outstanding requests', async () => {
    const f = fixture({ cascade: false })
    const result = await probePermissions(f.api, process.cwd(), { timeoutMs: 70, cleanupMs: 100 })
    expect(result.passed).toBe(false); expect(result.cascadeVerified).toBe(false)
    expect(result.cleanup.deleted).toBe(true); expect(f.pending.size).toBe(0)
  })
  it('does not explain an ordinary500 as an ended request404', async () => {
    const f = fixture({ stale500: true })
    const result = await probePermissions(f.api, process.cwd(), { timeoutMs: 200, cleanupMs: 100 })
    expect(result).toMatchObject({ passed: false, staleReply: { status: 500 }, cleanup: { deleted: true } })
  })
  it('bounds hanging cleanup and retains the session instead of announcing safe deletion', async () => {
    const f = fixture({ hangCleanup: true }); const start = Date.now()
    const result = await probePermissions(f.api, process.cwd(), { timeoutMs: 200, cleanupMs: 30 })
    expect(Date.now() - start).toBeLessThan(500); expect(result.passed).toBe(false)
    expect(result.cleanup.deleted).toBe(false); expect(f.raw.session.remove).not.toHaveBeenCalled()
  })
  it('fails closed on event EOF without making a permission decision', async () => {
    const f = fixture({ eof: true })
    const result = await probePermissions(f.api, process.cwd(), { timeoutMs: 100, cleanupMs: 100 })
    expect(result.passed).toBe(false); expect(result.streamError).not.toBeNull(); expect(f.rejected()).toBe(false)
  })
})
